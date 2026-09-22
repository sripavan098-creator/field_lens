#!/usr/bin/env python3
"""FieldLens server.

Two roles in one stdlib process, because the whole point is that no cloud is
involved:

* Mobile role  - serves the offline-first PWA from static/.
* Desktop role - implements the Office Kit receive protocol on the office LAN,
  lands incoming bundles in a SQLite inbox, and exposes the Flow State feed the
  desktop ERP shell resumes from.

There is deliberately no outbound network call anywhere in this file.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import logging
import mimetypes
import os
import re
import socket
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

APP_VERSION = "0.1.0"
OFFICE_KIT_PROTOCOL = "officekit/1"
ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DESKTOP_DIR = ROOT.parent / "desktop"
SCHEMA_PATH = ROOT / "schemas" / "record.schema.json"
DEFAULT_DB = ROOT / "fieldlens.db"

MAX_BODY_BYTES = 64 * 1024 * 1024  # one record's evidence must fit comfortably
ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
KINDS = {"invoice", "inspection", "inventory"}
SAFE_EVIDENCE_NAME = re.compile(r"[^A-Za-z0-9._-]")
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

log = logging.getLogger("fieldlens")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ulid() -> str:
    """Crockford base32 ULID: lexicographically sortable by capture time."""
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    ts = int(time.time() * 1000)
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ts << 80) | rand
    out = []
    for shift in range(125, -1, -5):
        out.append(alphabet[(value >> shift) & 0x1F])
    return "".join(out)


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_hash_for(record: dict[str, Any]) -> str:
    """Server-authoritative fingerprint of what a record actually says.

    The desktop derives this from the bytes it received rather than trusting a
    hash from the phone. Two reasons: a client cannot be allowed to decide its
    own identity for deduplication, and the two languages would need identical
    JSON canonicalisation (key order, float formatting) to agree, which is a
    fragile thing to build a data-integrity check on.

    Sync bookkeeping is excluded so that retrying an unchanged record produces
    the same fingerprint, while any change to a field, the narration, the site
    or the evidence does not.
    """
    material = {
        "kind": record.get("kind"),
        "capturedAt": record.get("capturedAt"),
        "capture": record.get("capture"),
        "fields": (record.get("extraction") or {}).get("fields"),
        "evidence": (record.get("evidence") or {}).get("sha256") or {},
    }
    return "sha256:" + hashlib.sha256(canonical_json(material).encode("utf-8")).hexdigest()


def device_fingerprint(device_id: str) -> str:
    """Stable short code the worker matches by eye when pairing phone to PC.

    Derived from the device id and the host name of the machine playing the
    desktop role, so two office PCs do not accept the same bundle silently.
    """
    material = f"{device_id}:{OFFICE_KIT_PROTOCOL}:{socket.gethostname()}"
    return hashlib.sha256(material.encode()).hexdigest()[:8].upper()


# --------------------------------------------------------------------------
# Inbox storage (desktop side)
# --------------------------------------------------------------------------


class Inbox:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS bundles (
                batch_id         TEXT PRIMARY KEY,
                device_id        TEXT NOT NULL,
                fingerprint      TEXT,
                received_at      TEXT NOT NULL,
                record_count     INTEGER NOT NULL,
                bytes_in         INTEGER NOT NULL,
                manifest         TEXT NOT NULL,
                applied          INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS records (
                id               TEXT PRIMARY KEY,
                batch_id         TEXT NOT NULL REFERENCES bundles(batch_id),
                kind             TEXT NOT NULL,
                captured_at      TEXT NOT NULL,
                received_at      TEXT NOT NULL,
                content_hash     TEXT NOT NULL UNIQUE,
                client_key       TEXT,
                confidence       REAL NOT NULL,
                needs_review     INTEGER NOT NULL,
                payload          TEXT NOT NULL,
                opened_at        TEXT,
                FOREIGN KEY (batch_id) REFERENCES bundles(batch_id)
            );

            CREATE INDEX IF NOT EXISTS records_active
                ON records(captured_at DESC, received_at DESC);
            CREATE INDEX IF NOT EXISTS records_batch ON records(batch_id);

            CREATE TABLE IF NOT EXISTS decisions (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id      TEXT NOT NULL,
                decided_at     TEXT NOT NULL,
                decision       TEXT NOT NULL,
                note           TEXT
            );
            """
        )
        self._conn.commit()

    # -- write path ------------------------------------------------------

    def receive(self, bundle: dict[str, Any], raw_len: int) -> dict[str, Any]:
        batch_id = bundle["batchId"]
        device_id = bundle["device"]["id"]
        records = bundle["records"]
        with self._lock:
            existing = self._conn.execute(
                "SELECT batch_id FROM bundles WHERE batch_id = ?", (batch_id,)
            ).fetchone()
            if existing:
                return {"status": "duplicate", "batchId": batch_id, "accepted": [], "conflicts": []}

            accepted, conflicts, unsupported = [], [], []
            for entry in records:
                verdict = self._apply_record(batch_id, device_id, entry)
                if verdict["status"] == "accepted":
                    accepted.append(verdict)
                elif verdict["status"] == "conflict":
                    conflicts.append(verdict)
                else:
                    unsupported.append(verdict)

            self._conn.execute(
                "INSERT INTO bundles (batch_id, device_id, fingerprint, received_at,"
                " record_count, bytes_in, manifest) VALUES (?,?,?,?,?,?,?)",
                (
                    batch_id,
                    device_id,
                    bundle.get("fingerprint"),
                    utcnow(),
                    len(records),
                    raw_len,
                    canonical_json(bundle.get("manifest", {})),
                ),
            )
            self._conn.commit()

        log.info(
            "officekit receive batch=%s device=%s records=%d accepted=%d conflicts=%d unsupported=%d",
            batch_id, device_id, len(records), len(accepted), len(conflicts), len(unsupported),
        )
        return {
            "status": "ok",
            "protocol": OFFICE_KIT_PROTOCOL,
            "batchId": batch_id,
            "receivedAt": utcnow(),
            "accepted": accepted,
            "conflicts": conflicts,
            "unsupported": unsupported,
        }

    def _apply_record(self, batch_id: str, device_id: str, entry: dict[str, Any]) -> dict[str, Any]:
        record = entry.get("record") or {}
        record_id = record.get("id", "")
        evidence = entry.get("evidence") or []

        if not ULID_RE.match(record_id):
            return {"status": "unsupported", "recordId": record_id, "reason": "malformed record id"}
        if record.get("kind") not in KINDS:
            return {"status": "unsupported", "recordId": record_id, "reason": "unknown extraction profile"}

        content_hash = content_hash_for(record)
        client_key = (record.get("sync") or {}).get("idempotencyKey")

        # The record id is the desktop's primary key, so one id can only ever
        # mean one row. Meeting the same id again is either the phone retrying
        # an unchanged record or a genuinely edited one, and the desktop's own
        # content hash distinguishes them without trusting the phone.
        existing = self._conn.execute(
            "SELECT id, content_hash FROM records WHERE id = ?", (record_id,)
        ).fetchone()
        if existing:
            if existing["content_hash"] == content_hash:
                return {
                    "status": "accepted",
                    "recordId": record_id,
                    "storedId": existing["id"],
                    "reason": "idempotent replay",
                }
            return {
                "status": "conflict",
                "recordId": record_id,
                "storedId": existing["id"],
                "reason": "this record id already arrived with different content; a human must pick a winner",
            }

        # A fresh id whose content is byte-identical to a record already here is
        # the same capture arriving twice, not a new observation.
        duplicate = self._conn.execute(
            "SELECT id FROM records WHERE content_hash = ?", (content_hash,)
        ).fetchone()
        if duplicate:
            return {
                "status": "accepted",
                "recordId": record_id,
                "storedId": duplicate["id"],
                "reason": "content already stored under another id; replay",
            }

        # Evidence is written to disk beside the DB, keyed by content hash, so a
        # re-capture of the same whiteboard does not duplicate bytes.
        evidence_dir = self.path.parent / "inbox" / batch_id / record_id
        for item in evidence:
            digest = item.get("sha256")
            data_b64 = item.get("base64") or ""
            safe_name = SAFE_EVIDENCE_NAME.sub("_", str(item.get("name") or ""))
            if not digest or not data_b64 or not safe_name:
                return {
                    "status": "unsupported",
                    "recordId": record_id,
                    "reason": "each evidence item needs a name, a sha256 and base64 bytes",
                }
            try:
                blob = base64.b64decode(data_b64, validate=True)
            except Exception:
                return {
                    "status": "conflict",
                    "recordId": record_id,
                    "reason": f"evidence {safe_name} is not valid base64",
                }
            if hashlib.sha256(blob).hexdigest() != digest:
                return {
                    "status": "conflict",
                    "recordId": record_id,
                    "reason": f"evidence {safe_name} failed hash check in transit",
                }
            evidence_dir.mkdir(parents=True, exist_ok=True)
            (evidence_dir / safe_name).write_bytes(blob)

        now = utcnow()
        self._conn.execute(
            "INSERT INTO records (id, batch_id, kind, captured_at, received_at,"
            " content_hash, client_key, confidence, needs_review, payload)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                record_id,
                batch_id,
                record["kind"],
                record.get("capturedAt", now),
                now,
                content_hash,
                client_key,
                float(record.get("extraction", {}).get("confidence", 0.0)),
                1 if record.get("extraction", {}).get("needsReview") else 0,
                canonical_json(record),
            ),
        )
        return {"status": "accepted", "recordId": record_id, "storedId": record_id, "reason": "new"}

    # -- read path -------------------------------------------------------

    def list_records(self, kind: str | None = None, status: str | None = None,
                     limit: int = 200) -> list[dict[str, Any]]:
        sql = (
            "SELECT r.*, b.fingerprint, b.received_at AS batch_received_at"
            " FROM records r JOIN bundles b ON b.batch_id = r.batch_id"
        )
        clauses, params = [], []
        if kind:
            clauses.append("r.kind = ?")
            params.append(kind)
        if status == "review":
            clauses.append("r.needs_review = 1")
        elif status == "ready":
            clauses.append("r.needs_review = 0")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY r.captured_at DESC, r.received_at DESC LIMIT ?"
        params.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def get_record(self, record_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT r.*, b.fingerprint FROM records r JOIN bundles b"
                " ON b.batch_id = r.batch_id WHERE r.id = ?",
                (record_id,),
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def touch(self, record_id: str, decision: str, note: str | None = None) -> bool:
        """Mark a record as the one the worker is actively on.

        This is the write that makes Flow State work: 'most recently active' is
        an explicit, durable signal rather than a guess from timestamps.
        """
        with self._lock:
            cur = self._conn.execute("UPDATE records SET opened_at = ? WHERE id = ?", (utcnow(), record_id))
            if cur.rowcount == 0:
                return False
            self._conn.execute(
                "INSERT INTO decisions (record_id, decided_at, decision, note) VALUES (?,?,?,?)",
                (record_id, utcnow(), decision, note),
            )
            self._conn.commit()
        return True

    def adjudicate(self, record_id: str, resolution: str, note: str | None) -> bool:
        with self._lock:
            self._conn.execute(
                "INSERT INTO decisions (record_id, decided_at, decision, note) VALUES (?,?,?,?)",
                (record_id, utcnow(), f"conflict:{resolution}", note),
            )
            self._conn.commit()
        return self.touch(record_id, f"conflict:{resolution}", note)

    def flow_state(self, window_minutes: int = 480) -> dict[str, Any]:
        """The resume payload for the desktop shell.

        Rule: if a bundle landed while the worker is back in the office, the
        first non-review record from the newest bundle becomes the active one,
        and its queue neighbours are handed over as the continuation context.
        Review-flagged records are surfaced separately so they cannot silently
        become ERP rows.
        """
        with self._lock:
            latest = self._conn.execute(
                "SELECT * FROM bundles ORDER BY received_at DESC LIMIT 1"
            ).fetchone()
            if not latest:
                return {
                    "active": None,
                    "continuation": [],
                    "pendingReview": [],
                    "reason": "no-office-kit-transfer-yet",
                    "generatedAt": utcnow(),
                }

            batch_rows = self._conn.execute(
                "SELECT r.*, b.fingerprint FROM records r JOIN bundles b ON b.batch_id = r.batch_id"
                " WHERE r.batch_id = ? ORDER BY r.captured_at DESC, r.received_at DESC",
                (latest["batch_id"],),
            ).fetchall()

            opened = self._conn.execute(
                "SELECT id FROM records WHERE opened_at IS NOT NULL"
                " ORDER BY opened_at DESC LIMIT 1"
            ).fetchone()

        records = [self._row_to_dict(row) for row in batch_rows]
        pending_review = [r for r in records if r["needsReview"]]
        clean = [r for r in records if not r["needsReview"]]

        active = None
        if opened:
            active = next((r for r in records if r["id"] == opened["id"]), None)
        if active is None and clean:
            active = clean[0]

        continuation = [r for r in clean if active is None or r["id"] != active["id"]]

        age_minutes = None
        if latest:
            try:
                received = datetime.fromisoformat(latest["received_at"].replace("Z", "+00:00"))
                age_minutes = round((datetime.now(timezone.utc) - received).total_seconds() / 60, 1)
            except ValueError:
                age_minutes = None

        return {
            "active": active,
            "continuation": continuation,
            "pendingReview": pending_review,
            "batchId": latest["batch_id"],
            "deviceId": latest["device_id"],
            "fingerprint": latest["fingerprint"],
            "receivedAt": latest["received_at"],
            "minutesSinceTransfer": age_minutes,
            "stale": bool(age_minutes is not None and age_minutes > window_minutes),
            "reason": "resumed-from-incoming-office-kit-transfer",
            "generatedAt": utcnow(),
        }

    def stats(self) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT (SELECT COUNT(*) FROM bundles) AS transfers,"
                " (SELECT COUNT(*) FROM records) AS records,"
                " (SELECT COUNT(*) FROM records WHERE needs_review = 1) AS review"
            ).fetchone()
        return {"transfers": row["transfers"], "records": row["records"], "needsReview": row["review"]}

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        payload = json.loads(row["payload"])
        return {
            "id": row["id"],
            "kind": row["kind"],
            "capturedAt": row["captured_at"],
            "receivedAt": row["received_at"],
            "batchId": row["batch_id"],
            "confidence": row["confidence"],
            "needsReview": bool(row["needs_review"]),
            "openedAt": row["opened_at"],
            "record": payload,
        }


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------


def validate_bundle(bundle: Any) -> str | None:
    """Structural validation of an Office Kit bundle.

    Returns a human-readable problem, or None when the bundle is safe to
    persist. The record-level JSON Schema governs field shape; this checks the
    envelope and the invariants the desktop depends on: a stable batch id, a
    device the pairing code vouches for, an idempotency key per record for safe
    replay, and proof that each record was authored with the radio off.
    """
    if not isinstance(bundle, dict):
        return "bundle must be a JSON object"
    for key in ("protocol", "batchId", "device", "manifest", "records"):
        if key not in bundle:
            return f"bundle is missing '{key}'"
    if bundle["protocol"] != OFFICE_KIT_PROTOCOL:
        return f"unsupported protocol {bundle['protocol']!r}; this desktop speaks {OFFICE_KIT_PROTOCOL}"
    if not ULID_RE.match(str(bundle["batchId"])):
        return "batchId must be a ULID"

    device = bundle["device"]
    if not isinstance(device, dict) or not device.get("id"):
        return "device.id is required"
    if not DEVICE_ID_RE.match(str(device["id"])):
        return "device.id contains characters this inbox will not store"
    fingerprint = device_fingerprint(device["id"])
    if bundle.get("fingerprint") and bundle["fingerprint"] != fingerprint:
        return "device fingerprint does not match the pairing code for this desktop"

    records = bundle["records"]
    if not isinstance(records, list) or not records:
        return "bundle must carry at least one record"
    for index, entry in enumerate(records):
        if not isinstance(entry, dict) or "record" not in entry or "evidence" not in entry:
            return f"records[{index}] must contain 'record' and 'evidence'"
        record = entry["record"]
        if not isinstance(record, dict):
            return f"records[{index}].record must be an object"
        for key in ("id", "kind", "capturedAt", "capture", "evidence", "extraction", "sync", "provenance"):
            if key not in record:
                return f"records[{index}].record is missing '{key}'"
        if not ULID_RE.match(str(record["id"])):
            return f"records[{index}].record.id must be a ULID"
        if record["kind"] not in KINDS:
            return f"records[{index}].record.kind must be one of {sorted(KINDS)}"
        sync = record["sync"]
        if not isinstance(sync, dict) or not sync.get("idempotencyKey"):
            return f"records[{index}].record.sync.idempotencyKey is required for safe replay"
        if record.get("provenance", {}).get("createdOffline") is not True:
            return f"records[{index}] claims to have been authored with connectivity; refusing it"
    return None


def scan_portable_inbox(inbox: "Inbox", inbox_dir: Path) -> int:
    """Ingest `.officekit.json` bundles dropped into the desktop inbox folder.

    This is the fallback path for a site with no shared network at all: the
    phone exports a portable bundle (the same bytes the HTTP transfer would
    have sent) and the worker copies it across on a stick. The desktop applies
    the identical validation, so a portable bundle cannot bypass any check.
    """
    if not inbox_dir.is_dir():
        return 0
    applied = 0
    for path in sorted(inbox_dir.glob("*.officekit.json")):
        try:
            bundle = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("ignoring unreadable portable bundle %s: %s", path.name, exc)
            continue
        problem = validate_bundle(bundle)
        if problem:
            log.warning("rejecting portable bundle %s: %s", path.name, problem)
            continue
        result = inbox.receive(bundle, path.stat().st_size)
        if result["status"] == "duplicate":
            path.rename(path.with_suffix(".json.applied"))
            continue
        log.info("portable bundle %s applied: %d accepted", path.name, len(result["accepted"]))
        path.rename(path.with_suffix(".json.applied"))
        applied += 1
    return applied


class Handler(BaseHTTPRequestHandler):
    server_version = f"FieldLens/{APP_VERSION}"
    protocol_version = "HTTP/1.1"

    inbox: Inbox

    # -- helpers ---------------------------------------------------------

    def _send(self, status: int, body: bytes, content_type: str,
              extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-FieldLens-Protocol", OFFICE_KIT_PROTOCOL)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: Any, extra: dict[str, str] | None = None) -> None:
        self._send(status, json.dumps(obj, indent=2).encode(), "application/json; charset=utf-8", extra)

    def _error(self, status: int, message: str, **details: Any) -> None:
        self._json(status, {"error": message, **details})

    def _read_body(self) -> tuple[bytes, str]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError(f"bundle of {length} bytes exceeds the {MAX_BODY_BYTES} byte transfer cap")
        raw = self.rfile.read(length) if length else b""
        encoding = (self.headers.get("Content-Encoding") or "identity").lower()
        if encoding == "gzip":
            raw = gzip.decompress(raw)
        elif encoding not in ("identity", ""):
            raise ValueError(f"unsupported content-encoding {encoding}")
        return raw, encoding

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter default logging
        log.debug("%s - %s", self.address_string(), fmt % args)

    # -- routes ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": True,
                "app": "fieldlens",
                "version": APP_VERSION,
                "protocol": OFFICE_KIT_PROTOCOL,
                "hostname": socket.gethostname(),
                "serverTime": utcnow(),
                "inbox": self.inbox.stats(),
                "cloudDependency": False,
            })
        elif path == "/api/schema":
            self._send(HTTPStatus.OK, SCHEMA_PATH.read_bytes(), "application/schema+json")
        elif path == "/api/inbox":
            records = self.inbox.list_records(
                kind=self._query(parsed, "kind"),
                status=self._query(parsed, "status"),
                limit=int(self._query(parsed, "limit") or 200),
            )
            self._json(HTTPStatus.OK, {"count": len(records), "records": records})
        elif path == "/api/queue":
            # The exact shape the Flow State Guardian polls on desktop boot.
            self._json(HTTPStatus.OK, self.inbox.flow_state())
        elif path.startswith("/api/inbox/"):
            record_id = unquote(path[len("/api/inbox/"):])
            record = self.inbox.get_record(record_id)
            if record is None:
                self._error(HTTPStatus.NOT_FOUND, "no such record", recordId=record_id)
            else:
                self._json(HTTPStatus.OK, record)
        elif path == "/api/pair":
            device_id = self._query(parsed, "device") or "UNKNOWN"
            self._json(HTTPStatus.OK, {
                "protocol": OFFICE_KIT_PROTOCOL,
                "hostname": socket.gethostname(),
                "fingerprint": device_fingerprint(device_id),
                "serverTime": utcnow(),
            })
        else:
            self._serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/pair/claim":
            self._pair_claim()
            return
        if path.startswith("/api/inbox/") and path.endswith("/touch"):
            record_id = unquote(path[len("/api/inbox/"):-len("/touch")])
            self._touch(record_id)
            return
        if path.startswith("/api/inbox/") and path.endswith("/resolve"):
            record_id = unquote(path[len("/api/inbox/"):-len("/resolve")])
            self._resolve(record_id)
            return
        if path == "/api/ingest":
            self._ingest()
            return
        self._error(HTTPStatus.NOT_FOUND, "unknown endpoint", path=path)

    def _pair_claim(self) -> None:
        try:
            raw, _ = self._read_body()
            body = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, f"malformed pairing request: {exc}")
            return
        device_id = str(body.get("deviceId") or "")
        claimed = str(body.get("fingerprint") or "")
        expected = device_fingerprint(device_id)
        if claimed != expected:
            log.warning("pairing refused for device=%s claimed=%s expected=%s", device_id, claimed, expected)
            self._error(
                HTTPStatus.FORBIDDEN,
                "fingerprint mismatch - confirm the code shown on the desktop before the first transfer",
                expected=expected,
            )
            return
        self._json(HTTPStatus.OK, {"paired": True, "protocol": OFFICE_KIT_PROTOCOL, "at": utcnow()})

    def _ingest(self) -> None:
        try:
            raw, encoding = self._read_body()
        except ValueError as exc:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, str(exc))
            return
        try:
            bundle = json.loads(raw)
        except json.JSONDecodeError as exc:
            self._error(HTTPStatus.BAD_REQUEST, f"bundle is not valid JSON: {exc.msg}", offset=exc.pos)
            return

        problem = validate_bundle(bundle)
        if problem:
            self._error(HTTPStatus.BAD_REQUEST, problem)
            return

        result = self.inbox.receive(bundle, len(raw))
        status = HTTPStatus.OK if result["status"] == "ok" else HTTPStatus.ACCEPTED
        result["bytesIn"] = len(raw)
        result["contentEncoding"] = encoding
        self._json(status, result)

    def _touch(self, record_id: str) -> None:
        try:
            raw, _ = self._read_body()
            body = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, f"malformed touch: {exc}")
            return
        if not self.inbox.touch(record_id, str(body.get("action") or "opened"), body.get("note")):
            self._error(HTTPStatus.NOT_FOUND, "no such record", recordId=record_id)
            return
        self._json(HTTPStatus.OK, {"ok": True, "recordId": record_id, "flowState": self.inbox.flow_state()})

    def _resolve(self, record_id: str) -> None:
        try:
            raw, _ = self._read_body()
            body = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, f"malformed resolution: {exc}")
            return
        resolution = str(body.get("resolution") or "")
        if resolution not in ("keep-local", "keep-desktop", "merged"):
            self._error(
                HTTPStatus.BAD_REQUEST,
                "resolution must be keep-local, keep-desktop or merged",
            )
            return
        if not self.inbox.adjudicate(record_id, resolution, body.get("note")):
            self._error(HTTPStatus.NOT_FOUND, "no such record", recordId=record_id)
            return
        self._json(HTTPStatus.OK, {"ok": True, "recordId": record_id, "resolution": resolution})

    # -- static ----------------------------------------------------------

    def _query(self, parsed, name: str) -> str | None:
        values = parse_qs(parsed.query).get(name)
        return values[0] if values else None

    def _serve_static(self, path: str) -> None:
        # The desktop shell is a separate folder because on a real deployment it
        # is opened beside the ERP rather than from the phone's origin, but
        # serving it here means one process covers both halves on a single
        # machine. `/desktop` is the explicit prefix so it can never shadow the
        # mobile app's own files.
        if path == "/desktop" or path.startswith("/desktop/"):
            rel = path[len("/desktop"):].lstrip("/") or "index.html"
            root = DESKTOP_DIR
        else:
            rel = "index.html" if path in ("/", "") else unquote(path).lstrip("/")
            root = STATIC_DIR

        target = (root / rel).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file():
            self._error(HTTPStatus.NOT_FOUND, "not found", path=path)
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send(HTTPStatus.OK, target.read_bytes(), ctype)


def build_server(host: str, port: int, db_path: Path, inbox_dir: Path) -> ThreadingHTTPServer:
    inbox = Inbox(db_path)
    scan_portable_inbox(inbox, inbox_dir)

    def scan_loop() -> None:
        while True:
            time.sleep(5)
            try:
                scan_portable_inbox(inbox, inbox_dir)
            except Exception:  # keep the desktop alive; a bad file must not kill it
                log.exception("portable inbox scan failed")

    threading.Thread(target=scan_loop, name="portable-inbox", daemon=True).start()

    handler = type("BoundHandler", (Handler,), {"inbox": inbox})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd


def main() -> None:
    parser = argparse.ArgumentParser(description="FieldLens offline-first server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 12000)))
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("FIELDLENS_DB", DEFAULT_DB)))
    parser.add_argument("--inbox", type=Path, default=Path(os.environ.get("FIELDLENS_INBOX", ROOT / "inbox")),
                        help="folder watched for portable .officekit.json bundles")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    httpd = build_server(args.host, args.port, args.db, args.inbox)
    log.info("FieldLens %s listening on http://%s:%d (protocol %s)", APP_VERSION, args.host, args.port, OFFICE_KIT_PROTOCOL)
    log.info("mobile UI  : http://<phone-reachable-ip>:%d/", args.port)
    log.info("desktop API: http://127.0.0.1:%d/api/queue", args.port)
    log.info("inbox db   : %s", args.db)
    log.info("watch dir  : %s", args.inbox)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
