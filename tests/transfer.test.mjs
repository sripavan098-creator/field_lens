/**
 * Office Kit wire-contract tests.
 *
 * The two halves of FieldLens are written in different languages, and the only
 * thing holding them together is the bundle format. These tests run the real
 * browser transfer module against the real Python server over a real socket, so
 * a change to either side that breaks the format fails here rather than on a
 * phone in a field.
 *
 * The store is stood in for by a Map-backed fake. That is deliberate: Node has
 * no IndexedDB, and the unit under test is transfer.js's wire output, not the
 * store's persistence. Everything else - fetch, Blob, base64, the HTTP server,
 * SQLite, the validator - is the production code path.
 *
 *   node --test tests/transfer.test.mjs
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OfficeKitClient, PROTOCOL, describeTarget, normaliseBaseUrl } from "../fieldlens/static/transfer.js";
import { STATUS, sha256Hex } from "../fieldlens/static/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "fieldlens", "server.py");

let child;
let base;
let workspace;

/** Minimal fake of the FieldStore surface OfficeKitClient actually touches. */
class FakeStore {
  constructor() {
    this.records = new Map();
    this.evidence = new Map();
    this.meta = new Map();
    this.deviceId = "FL-TEST01";
  }

  async open() { return this; }
  async getMeta(key) { return this.meta.get(key) ?? null; }
  async setMeta(key, value) { this.meta.set(key, value); return value; }
  async putEvidence(key, blob, meta) { this.evidence.set(key, { blob, ...meta }); }
  async getEvidence(key) { return this.evidence.get(key) ?? null; }
  async put(record) { this.records.set(record.id, record); return record; }
  async get(id) { return this.records.get(id) ?? null; }
  async all() { return [...this.records.values()].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)); }
  async byStatus(statuses) {
    const wanted = new Set(statuses);
    return (await this.all()).filter((r) => wanted.has(r.sync.status));
  }
  async update(id, mutate) {
    const record = this.records.get(id);
    if (!record) return null;
    const next = mutate(record) || record;
    this.records.set(id, next);
    return next;
  }
  async advance(id, status, patch = {}) {
    const record = this.records.get(id);
    if (!record) return null;
    record.sync = { ...record.sync, ...patch, status };
    this.records.set(id, record);
    return record;
  }
}

function ulidSuffix(n) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = 1_700_000_000_000 + n;
  let out = "";
  for (let i = 0; i < 10; i += 1) { out = alphabet[ts % 32] + out; ts = Math.floor(ts / 32); }
  const fill = alphabet[n % 32].repeat(16);
  return out + fill;
}

async function makeStoredRecord(store, { id, fields, kind = "inventory", needsReview = false, status = STATUS.VERIFIED }) {
  const photoBytes = new TextEncoder().encode(`jpeg-${id}`);
  const audioBytes = new TextEncoder().encode(`audio-${id}`);
  const photoBlob = new Blob([photoBytes], { type: "image/jpeg" });
  const audioBlob = new Blob([audioBytes], { type: "audio/webm" });
  const photoSha = await sha256Hex(photoBytes);
  const audioSha = await sha256Hex(audioBytes);
  await store.putEvidence(`photo:${id}`, photoBlob, { mime: "image/jpeg" });
  await store.putEvidence(`audio:${id}`, audioBlob, { mime: "audio/webm" });

  const record = {
    id,
    kind,
    capturedAt: "2026-09-22T07:30:00.000Z",
    capture: { narration: "SKU AB-4471, quantity 240 in bin C-12", site: "Depot 4", operator: "R. Okafor", geo: null },
    evidence: {
      photoCount: 1,
      audioMs: 4200,
      sha256: { photo: photoSha, audio: audioSha },
      items: [{ name: "frame.jpg", storageKey: `photo:${id}`, mime: "image/jpeg", sha256: photoSha, bytes: photoBlob.size }],
      audioKey: `audio:${id}`,
      audioSha256: audioSha,
    },
    extraction: {
      fields,
      confidence: 0.91,
      engine: "phi-3-vision-int4:npu",
      needsReview,
      fieldSources: { sku: "audio", quantity: "fused" },
      missingRequired: [],
    },
    narrative: "Offline capture.",
    sync: { status, attempts: 0, idempotencyKey: `client-key:${id}`, lastError: null, ackedAt: null, batchId: null },
    provenance: { deviceId: store.deviceId, appVersion: "0.1.0", createdOffline: true, clockSkewRisk: false },
  };
  await store.put(record);
  return record;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "fieldlens-e2e-"));
  const port = 13000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  child = spawn("python", [SERVER, "--port", String(port), "--db", path.join(workspace, "inbox.db"),
    "--inbox", path.join(workspace, "portable")], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const probe = await fetch(`${base}/api/health`, { cache: "no-store" });
      if (probe.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("FieldLens server did not start");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

after(() => {
  child?.kill("SIGTERM");
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

test("target parsing recognises the shapes a worker actually types", () => {
  assert.equal(normaliseBaseUrl("192.168.1.20:12000"), "http://192.168.1.20:12000");
  assert.equal(normaliseBaseUrl("http://10.0.0.5:12000/"), "http://10.0.0.5:12000");
  assert.equal(describeTarget("192.168.1.20:12000").looksLocal, true);
  assert.equal(describeTarget("office-pc.local:12000").looksLocal, true);
  assert.equal(describeTarget("fieldlens.example.com").looksLocal, false);
});

test("the phone and desktop agree on the pairing code", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store);

  const probe = await client.probe(base);
  assert.equal(probe.reachable, true);
  assert.equal(probe.protocol, PROTOCOL);

  const fingerprint = await client.fingerprintFor(base, store.deviceId);
  assert.match(fingerprint, /^[0-9A-F]{8}$/);

  const saved = await client.claimPairing(base);
  assert.equal(saved.fingerprint, fingerprint);
  assert.equal(saved.baseUrl, base);

  const pairing = await client.pairing();
  assert.equal(pairing.fingerprint, fingerprint);
});

test("a verified record crosses the wire with its evidence intact", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store);
  const record = await makeStoredRecord(store, { id: ulidSuffix(1), fields: { sku: "AB-4471", quantity: 240, bin: "C-12" } });

  const report = await client.sync(base);
  assert.equal(report.outcome, "delivered");
  assert.equal(report.acked, 1);
  assert.equal(report.batchId.length, 26, "the batch id must be a ULID the desktop accepts");

  const updated = await store.get(record.id);
  assert.equal(updated.sync.status, STATUS.ACKED);
  assert.ok(updated.sync.ackedAt);

  const stored = await getJson(`${base}/api/inbox/${record.id}`);
  assert.equal(stored.status, 200);
  assert.equal(stored.body.record.extraction.fields.sku, "AB-4471");
  assert.equal(stored.body.record.provenance.createdOffline, true);
  assert.equal(stored.body.record.capture.narration, record.capture.narration);
});

test("the evidence bytes the desktop stores hash to what the phone recorded", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store);
  const id = ulidSuffix(2);
  const record = await makeStoredRecord(store, { id, fields: { sku: "AB-4472", quantity: 12 } });
  await client.sync(base);

  const reported = record.evidence.sha256.photo;
  const recomputed = await sha256Hex(new TextEncoder().encode(`jpeg-${id}`));
  assert.equal(reported, recomputed);
  // The desktop only accepts the record if its own hash of the decoded bytes
  // matches, so an accepted record proves the bytes survived the trip.
  const stored = await getJson(`${base}/api/inbox/${id}`);
  assert.equal(stored.body.record.evidence.sha256.photo, reported);
});

test("retrying a sync the desktop already has is reported as already delivered", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store);
  const id = ulidSuffix(3);
  const record = await makeStoredRecord(store, { id, fields: { sku: "AB-4473", quantity: 5 } });

  await client.sync(base);
  // The phone did not see the ack (screen locked, cable pulled) and retries.
  await store.advance(id, STATUS.QUEUED, { attempts: 1, batchId: null });
  const retry = await client.sync(base);

  assert.equal(retry.outcome, "already-delivered");
  assert.equal(retry.sent, 1);

  const inbox = await getJson(`${base}/api/inbox`);
  const count = inbox.body.records.filter((r) => r.id === id).length;
  assert.equal(count, 1, "a retried record must not appear twice in the inbox");
});

test("a record with an unread required field is refused by the send set", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store);
  await makeStoredRecord(store, {
    id: ulidSuffix(4), status: STATUS.NEEDS_REVIEW, needsReview: true,
    fields: { sku: "AB-4474", quantity: null },
  });

  const ready = await client.readyRecords();
  assert.equal(ready.length, 0, "an unverified record must not be sendable");

  const report = await client.sync(base);
  assert.equal(report.sent, 0);
  assert.equal(report.outcome, "queue-empty");
});

test("a sync against an unreachable desktop fails the records and keeps them retryable", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store, { timeoutMs: 1500 });
  const id = ulidSuffix(5);
  await makeStoredRecord(store, { id, fields: { sku: "AB-4475", quantity: 1 } });

  await assert.rejects(() => client.sync("http://127.0.0.1:1"), /cannot reach the desktop/);
  const record = await store.get(id);
  assert.equal(record.sync.status, STATUS.QUEUED, "a failed transfer must leave the record retryable");
  assert.ok(record.sync.attempts >= 1);
  assert.ok(record.sync.lastError, "the failure reason must be recorded for the worker");
});

test("the flow state feed hands the desktop the transferred record immediately", async () => {
  const store = new FakeStore();
  const client = new OfficeKitClient(store);
  const id = ulidSuffix(6);
  await makeStoredRecord(store, { id, fields: { sku: "AB-4476", quantity: 88, bin: "D-4" } });

  await client.sync(base);
  const flow = await getJson(`${base}/api/queue`);

  assert.equal(flow.status, 200);
  assert.equal(flow.body.active.id, id, "the just-transferred record is what the desktop resumes");
  assert.equal(flow.body.reason, "resumed-from-incoming-office-kit-transfer");
  assert.equal(flow.body.deviceId, store.deviceId);
  assert.equal(flow.body.continuation.length, 0);
});
