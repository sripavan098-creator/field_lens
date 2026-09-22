"""Office Kit protocol tests.

These exercise the real HTTP server against a real SQLite inbox, because the
contracts worth protecting are the cross-device ones: a bundle that lands twice
must not become two ERP rows, a bundle with tampered evidence must be refused,
and the Flow State feed must hand the worker back the record they were last on.

    python -m unittest discover -s tests
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "fieldlens"))

import server  # noqa: E402


def ulid(seed: int = 0) -> str:
    """Deterministic, valid, and ordered roughly by seed."""
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    ts = 1_700_000_000_000 + seed
    rand = seed + 1  # ensures distinct ids even for the same timestamp
    value = (ts << 80) | rand
    out = []
    for shift in range(125, -1, -5):
        out.append(alphabet[(value >> shift) & 0x1F])
    return "".join(out)


def make_record(record_id: str, *, kind: str = "inventory", fields: dict | None = None,
                evidence=None, offline: bool = True) -> dict:
    evidence = evidence if evidence is not None else [("frame.jpg", b"\xff\xd8fake-jpeg-bytes")]
    items = []
    wire_evidence = []
    for name, blob in evidence:
        digest = hashlib.sha256(blob).hexdigest()
        wire_evidence.append({
            "name": name,
            "mime": "image/jpeg",
            "sha256": digest,
            "bytes": len(blob),
            "base64": base64.b64encode(blob).decode(),
        })
        items.append({"name": name, "mime": "image/jpeg", "sha256": digest, "bytes": len(blob)})

    record = {
        "id": record_id,
        "kind": kind,
        "capturedAt": "2026-09-22T08:15:00.000Z",
        "capture": {"narration": "SKU AB-4471, quantity 240 in bin C-12", "site": "Depot 4", "operator": "R. Okafor", "geo": None},
        "evidence": {"photoCount": len(items), "audioMs": 4200, "sha256": {i["name"]: i["sha256"] for i in items}},
        "extraction": {
            "fields": fields if fields is not None else {"sku": "AB-4471", "quantity": 240, "bin": "C-12"},
            "confidence": 0.91,
            "engine": "phi-3-vision-int4:npu",
            "needsReview": False,
            "fieldSources": {"sku": "audio", "quantity": "fused", "bin": "audio"},
        },
        "sync": {
            "status": "queued",
            "attempts": 1,
            # The phone's own key. The desktop keeps it for traceability but
            # deduplicates on its own content hash, so the value is not load
            # bearing here.
            "idempotencyKey": f"client-key:{record_id}",
            "lastError": None,
            "ackedAt": None,
            "batchId": None,
        },
        "provenance": {
            "deviceId": "FL-0001",
            "appVersion": "0.1.0",
            "createdOffline": offline,
            "clockSkewRisk": False,
        },
        "narrative": "Offline capture.",
    }
    return {"record": record, "evidence": wire_evidence}


def make_bundle(batch_id: str, records: list[dict], *, device_id: str = "FL-0001",
                include_fingerprint: bool = True, protocol: str = server.OFFICE_KIT_PROTOCOL) -> dict:
    bundle = {
        "protocol": protocol,
        "batchId": batch_id,
        "device": {"id": device_id, "platform": "test"},
        "manifest": {"createdAt": "2026-09-22T12:00:00.000Z", "recordCount": len(records)},
        "records": records,
    }
    if include_fingerprint:
        bundle["fingerprint"] = server.device_fingerprint(device_id)
    return bundle


class ServerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.httpd = server.build_server("127.0.0.1", 0, root / "inbox.db", root / "portable")
        port = self.httpd.server_address[1]
        self.base = f"http://127.0.0.1:{port}"
        import threading

        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def call(self, path: str, method: str = "GET", payload=None, raw: bytes | None = None,
             headers: dict | None = None):
        body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        request = urllib.request.Request(f"{self.base}{path}", data=body, method=method,
                                         headers=headers or {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def fetch_raw(self, path: str):
        request = urllib.request.Request(f"{self.base}{path}")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as err:
            return err.code, err.read(), err.headers.get("Content-Type", "")

    # -- tests -------------------------------------------------------

    def test_health_reports_no_cloud_dependency(self):
        status, body = self.call("/api/health")
        self.assertEqual(status, 200)
        self.assertFalse(body["cloudDependency"])
        self.assertEqual(body["protocol"], server.OFFICE_KIT_PROTOCOL)

    def test_a_bundle_lands_and_its_evidence_is_hashed_onto_disk(self):
        entry = make_record(ulid(1))
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(100), [entry]))
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual([a["status"] for a in body["accepted"]], ["accepted"])

        status, record = self.call(f"/api/inbox/{ulid(1)}")
        self.assertEqual(status, 200)
        self.assertEqual(record["record"]["extraction"]["fields"]["sku"], "AB-4471")

        digest = hashlib.sha256(b"\xff\xd8fake-jpeg-bytes").hexdigest()
        stored = Path(self.tmp.name) / "inbox" / ulid(100) / ulid(1) / "frame.jpg"
        self.assertTrue(stored.is_file(), "evidence must be retained beside the inbox")
        self.assertEqual(hashlib.sha256(stored.read_bytes()).hexdigest(), digest)

    def test_resending_the_same_batch_is_a_no_op(self):
        entry = make_record(ulid(2))
        bundle = make_bundle(ulid(101), [entry])
        self.call("/api/ingest", "POST", bundle)
        status, body = self.call("/api/ingest", "POST", bundle)
        self.assertEqual(status, 202)
        self.assertEqual(body["status"], "duplicate")
        _, inbox = self.call("/api/inbox")
        self.assertEqual(inbox["count"], 1, "a repeated transfer must not double the inbox")

    def test_the_same_record_in_a_new_bundle_replays_instead_of_duplicating(self):
        # The dropped-connection case: the phone never saw the ack, so it retries
        # in a fresh bundle. One ERP row, not two.
        entry = make_record(ulid(3))
        self.call("/api/ingest", "POST", make_bundle(ulid(102), [entry]))
        retry = make_record(ulid(3))
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(103), [retry]))
        self.assertEqual(status, 200)
        self.assertEqual(body["accepted"][0]["reason"], "idempotent replay")
        _, inbox = self.call("/api/inbox")
        self.assertEqual(inbox["count"], 1)

    def test_corrected_content_raises_a_conflict_not_an_overwrite(self):
        entry = make_record(ulid(4), fields={"sku": "AB-4471", "quantity": 240})
        self.call("/api/ingest", "POST", make_bundle(ulid(104), [entry]))

        # Same record id, genuinely different content: the worker fixed the count
        # on the phone and re-synced. The desktop must not silently swap it.
        corrected = make_record(ulid(4), fields={"sku": "AB-4471", "quantity": 239},
                                evidence=[("frame.jpg", b"\xff\xd8corrected-frame")])
        self.assertNotEqual(server.content_hash_for(corrected["record"]),
                            server.content_hash_for(entry["record"]),
                            "the fixture must actually change the record's content")
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(105), [corrected]))
        self.assertEqual(status, 200)
        self.assertEqual(len(body["accepted"]), 0)
        self.assertEqual(len(body["conflicts"]), 1)
        self.assertIn("human must pick a winner", body["conflicts"][0]["reason"])

        _, record = self.call(f"/api/inbox/{ulid(4)}")
        self.assertEqual(record["record"]["extraction"]["fields"]["quantity"], 240,
                         "the desktop copy must not be overwritten silently")

    def test_an_edited_record_synced_before_its_first_delivery_is_accepted(self):
        # The common case: the worker corrects the record while still in the
        # field, so the corrected version is the first one the desktop ever sees.
        entry = make_record(ulid(46), fields={"sku": "AB-4471", "quantity": 240})
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(146), [entry]))
        self.assertEqual(status, 200)
        self.assertEqual(len(body["accepted"]), 1)

        edited = make_record(ulid(47), fields={"sku": "AB-4471", "quantity": 239},
                             evidence=[("frame.jpg", b"\xff\xd8edited-frame")])
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(147), [edited]))
        self.assertEqual(status, 200)
        self.assertEqual(len(body["accepted"]), 1)
        _, record = self.call(f"/api/inbox/{ulid(47)}")
        self.assertEqual(record["record"]["extraction"]["fields"]["quantity"], 239)

    def test_a_lying_client_key_cannot_fool_the_deduplicator(self):
        # A phone (or anything impersonating one) claims two different captures
        # are the same record by reusing one client key. The desktop must ignore
        # that claim and key off the content it actually received.
        first = make_record(ulid(45))
        first["record"]["sync"]["idempotencyKey"] = "shared-key"
        second = make_record(ulid(46), fields={"sku": "ZZ-9999", "quantity": 7},
                             evidence=[("frame.jpg", b"\xff\xd8second-capture")])
        second["record"]["sync"]["idempotencyKey"] = "shared-key"

        self.call("/api/ingest", "POST", make_bundle(ulid(145), [first]))
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(146), [second]))
        self.assertEqual(status, 200)
        self.assertEqual(len(body["accepted"]), 1)
        _, inbox = self.call("/api/inbox")
        self.assertEqual(inbox["count"], 2, "different captures must both survive a reused client key")

    def test_tampered_evidence_is_refused(self):
        entry = make_record(ulid(5))
        entry["evidence"][0]["base64"] = base64.b64encode(b"\xff\xd8different-bytes").decode()
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(106), [entry]))
        self.assertEqual(status, 200)
        self.assertEqual(len(body["conflicts"]), 1)
        self.assertIn("failed hash check", body["conflicts"][0]["reason"])
        _, inbox = self.call("/api/inbox")
        self.assertEqual(inbox["count"], 0)

    def test_a_record_claiming_it_was_written_online_is_rejected(self):
        entry = make_record(ulid(6), offline=False)
        status, body = self.call("/api/ingest", "POST", make_bundle(ulid(107), [entry]))
        self.assertEqual(status, 400)
        self.assertIn("connectivity", body["error"])

    def test_a_wrong_fingerprint_is_rejected_at_the_envelope(self):
        bundle = make_bundle(ulid(108), [make_record(ulid(7))])
        bundle["fingerprint"] = "DEADBEEF"
        status, body = self.call("/api/ingest", "POST", bundle)
        self.assertEqual(status, 400)
        self.assertIn("fingerprint", body["error"])

    def test_an_unknown_protocol_version_is_rejected(self):
        bundle = make_bundle(ulid(109), [make_record(ulid(8))], protocol="officekit/99")
        status, body = self.call("/api/ingest", "POST", bundle)
        self.assertEqual(status, 400)
        self.assertIn("unsupported protocol", body["error"])

    def test_pairing_claim_must_match_the_code_the_desktop_shows(self):
        expected = server.device_fingerprint("FL-0001")
        status, body = self.call("/api/pair?device=FL-0001")
        self.assertEqual(status, 200)
        self.assertEqual(body["fingerprint"], expected)

        status, _ = self.call("/api/pair/claim", "POST", {"deviceId": "FL-0001", "fingerprint": expected})
        self.assertEqual(status, 200)

        status, body = self.call("/api/pair/claim", "POST", {"deviceId": "FL-0001", "fingerprint": "00000000"})
        self.assertEqual(status, 403)
        self.assertIn("fingerprint mismatch", body["error"])

    def test_gzip_encoded_bundle_is_accepted(self):
        entry = make_record(ulid(9))
        raw = gzip.compress(json.dumps(make_bundle(ulid(110), [entry])).encode())
        status, body = self.call("/api/ingest", "POST", raw=raw,
                                 headers={"Content-Type": "application/json", "Content-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(body["contentEncoding"], "gzip")
        _, inbox = self.call("/api/inbox")
        self.assertEqual(inbox["count"], 1)

    # -- Flow State --------------------------------------------------

    def test_flow_state_opens_nothing_when_no_transfer_has_landed(self):
        status, flow = self.call("/api/queue")
        self.assertEqual(status, 200)
        self.assertIsNone(flow["active"])
        self.assertEqual(flow["reason"], "no-office-kit-transfer-yet")

    def test_flow_state_resumes_the_newest_batch_and_holds_review_records_back(self):
        clean_a = make_record(ulid(20))
        clean_b = make_record(ulid(21), evidence=[("frame.jpg", b"b21")])
        flagged = make_record(ulid(22),
                              fields={"sku": "AB-4471", "quantity": None}, evidence=[("frame.jpg", b"b22")])
        flagged["record"]["extraction"]["needsReview"] = True

        self.call("/api/ingest", "POST", make_bundle(ulid(120), [clean_a, clean_b, flagged]))

        status, flow = self.call("/api/queue")
        self.assertEqual(status, 200)
        self.assertEqual(flow["batchId"], ulid(120))
        self.assertIsNotNone(flow["active"])
        self.assertNotIn(flow["active"]["id"], {ulid(22)}, "a review record must not become the active ERP row")
        self.assertEqual({r["id"] for r in flow["pendingReview"]}, {ulid(22)})
        self.assertEqual(len(flow["continuation"]), 1)

    def test_touching_a_record_makes_it_the_one_resumed(self):
        first = make_record(ulid(30))
        second = make_record(ulid(31), evidence=[("frame.jpg", b"b31")])
        self.call("/api/ingest", "POST", make_bundle(ulid(130), [first, second]))

        _, initial = self.call("/api/queue")
        self.assertNotEqual(initial["active"]["id"], ulid(31))

        status, body = self.call(f"/api/inbox/{ulid(31)}/touch", "POST", {"action": "opened", "note": "desktop"})
        self.assertEqual(status, 200)
        self.assertEqual(body["flowState"]["active"]["id"], ulid(31))

        # A fresh poll - the desktop shell restarting - must remember it.
        _, resumed = self.call("/api/queue")
        self.assertEqual(resumed["active"]["id"], ulid(31))

    def test_a_conflict_can_be_adjudicated_and_is_recorded(self):
        entry = make_record(ulid(40))
        self.call("/api/ingest", "POST", make_bundle(ulid(140), [entry]))
        status, body = self.call(f"/api/inbox/{ulid(40)}/resolve", "POST",
                                 {"resolution": "keep-desktop", "note": "phone had a stale total"})
        self.assertEqual(status, 200)
        self.assertEqual(body["resolution"], "keep-desktop")

        status, body = self.call(f"/api/inbox/{ulid(40)}/resolve", "POST", {"resolution": "nonsense"})
        self.assertEqual(status, 400)

    def test_inbox_filters_by_kind_and_review_state(self):
        self.call("/api/ingest", "POST", make_bundle(ulid(150), [
            make_record(ulid(50), kind="invoice",
                        fields={"vendor": "Acme", "total": 1416}, evidence=[("frame.jpg", b"i50")]),
            make_record(ulid(51), kind="inventory"),
        ]))
        _, invoices = self.call("/api/inbox?kind=invoice")
        self.assertEqual([r["id"] for r in invoices["records"]], [ulid(50)])
        _, ready = self.call("/api/inbox?status=ready")
        self.assertEqual(len(ready["records"]), 2)

    def test_portable_bundle_dropped_in_the_watch_folder_is_applied(self):
        watch = Path(self.tmp.name) / "portable"
        watch.mkdir(parents=True, exist_ok=True)
        bundle = make_bundle(ulid(160), [make_record(ulid(60))])
        (watch / "fieldlens-test.officekit.json").write_text(json.dumps(bundle))

        handler_inbox = self.httpd.RequestHandlerClass.inbox
        applied = server.scan_portable_inbox(handler_inbox, watch)
        self.assertEqual(applied, 1)
        _, inbox = self.call("/api/inbox")
        self.assertEqual(inbox["count"], 1)
        self.assertTrue(list(watch.glob("*.applied")), "an applied bundle must be marked so it is not replayed")

        # Running the scan again must not duplicate anything.
        self.assertEqual(server.scan_portable_inbox(handler_inbox, watch), 0)

    def test_malformed_json_is_a_clean_400(self):
        status, body = self.call("/api/ingest", "POST", raw=b"{not json",
                                 headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertIn("not valid JSON", body["error"])

    def test_desktop_shell_is_served_beside_the_mobile_app(self):
        status, body, _ = self.fetch_raw("/desktop/")
        self.assertEqual(status, 200)
        self.assertIn(b"Flow State Guardian", body)

        status, body, ctype = self.fetch_raw("/desktop/desktop.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", ctype)

        # The desktop prefix must not become a way around the static root.
        status, _, _ = self.fetch_raw("/desktop/../fieldlens/server.py")
        self.assertIn(status, (400, 404))

    def test_static_shell_is_served_and_path_traversal_is_refused(self):
        status, body, ctype = self.fetch_raw("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b"FieldLens", body)

        # A traversal attempt must not escape the static root.
        status, _, _ = self.fetch_raw("/../server.py")
        self.assertIn(status, (400, 404))
        status, _, _ = self.fetch_raw("/%2e%2e/server.py")
        self.assertIn(status, (400, 404))


if __name__ == "__main__":
    unittest.main(verbosity=2)
