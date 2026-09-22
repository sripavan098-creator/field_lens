/**
 * FieldLens offline store.
 *
 * Everything the worker captures lives here first, in IndexedDB on the phone,
 * with the original photo and audio kept as blobs next to the extracted row.
 * The record shape is deliberately the same one the desktop inbox stores, so a
 * transfer is a copy rather than a translation and nothing is lost between the
 * two halves of the workflow.
 */

export const DB_NAME = "fieldlens";
export const DB_VERSION = 1;
export const STORE_RECORDS = "records";
export const STORE_EVIDENCE = "evidence";
export const STORE_META = "meta";

export const STATUS = {
  DRAFT: "draft",
  NEEDS_REVIEW: "needs_review",
  VERIFIED: "verified",
  QUEUED: "queued",
  TRANSFERRING: "transferring",
  ACKED: "acked",
  CONFLICT: "conflict",
  FAILED: "failed",
};

/** Order of progression through the queue. A record only moves forward. */
const RANK = {
  [STATUS.DRAFT]: 0,
  [STATUS.NEEDS_REVIEW]: 1,
  [STATUS.VERIFIED]: 2,
  [STATUS.QUEUED]: 3,
  [STATUS.TRANSFERRING]: 4,
  [STATUS.ACKED]: 5,
};

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Crockford base32 ULID: 48 bits of timestamp then 80 bits of randomness, for
 * 26 characters total. The desktop stores records under this id, so it must be
 * exactly the format the server validates - 10 time characters, 16 random.
 */
export function ulid() {
  let ts = Date.now();
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let random = "";
  for (const byte of bytes) random += ULID_ALPHABET[byte % 32];
  return time + random;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value) {
  return typeof value === "string" && ULID_RE.test(value);
}

export async function sha256Hex(blob) {
  const buffer = blob instanceof Blob ? await blob.arrayBuffer() : blob;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Deterministic fallback so evidence hashes still work on a locked-down
  // webview without SubtleCrypto. Not a security boundary, just integrity.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i += 1) {
    h1 = ((h1 ^ view[i]) * 16777619) >>> 0;
    h2 = ((h2 + view[i]) * 2654435761) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4);
}

export function estimateAudioMs(blob, bytesPerSecond) {
  if (!blob) return 0;
  return Math.round((blob.size / bytesPerSecond) * 1000);
}

/* ------------------------------------------------------------------ */

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

export class FieldStore {
  constructor() {
    this.db = null;
    this.deviceId = null;
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const store = db.createObjectStore(STORE_RECORDS, { keyPath: "id" });
          store.createIndex("syncStatus", "sync.status");
          store.createIndex("capturedAt", "capturedAt");
          store.createIndex("kind", "kind");
        }
        if (!db.objectStoreNames.contains(STORE_EVIDENCE)) {
          db.createObjectStore(STORE_EVIDENCE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.deviceId = await this._deviceId();
    return this.db;
  }

  async _deviceId() {
    const existing = await this.getMeta("deviceId");
    if (existing) return existing.value;
    const id = `FL-${ulid().slice(-8)}`;
    await this.setMeta("deviceId", id);
    return id;
  }

  async getMeta(key) {
    const tx = this.db.transaction(STORE_META, "readonly");
    const row = await requestAsPromise(tx.objectStore(STORE_META).get(key));
    return row || null;
  }

  async setMeta(key, value) {
    const tx = this.db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put({ key, value });
    await txDone(tx);
    return value;
  }

  /* -- evidence ---------------------------------------------------- */

  async putEvidence(key, blob, meta = {}) {
    const tx = this.db.transaction(STORE_EVIDENCE, "readwrite");
    tx.objectStore(STORE_EVIDENCE).put({ key, blob, ...meta });
    await txDone(tx);
  }

  async getEvidence(key) {
    const tx = this.db.transaction(STORE_EVIDENCE, "readonly");
    return (await requestAsPromise(tx.objectStore(STORE_EVIDENCE).get(key))) || null;
  }

  async deleteEvidence(keys) {
    if (!keys?.length) return;
    const tx = this.db.transaction(STORE_EVIDENCE, "readwrite");
    const store = tx.objectStore(STORE_EVIDENCE);
    for (const key of keys) store.delete(key);
    await txDone(tx);
  }

  /* -- records ----------------------------------------------------- */

  async put(record) {
    const tx = this.db.transaction(STORE_RECORDS, "readwrite");
    tx.objectStore(STORE_RECORDS).put(record);
    await txDone(tx);
    return record;
  }

  async get(id) {
    const tx = this.db.transaction(STORE_RECORDS, "readonly");
    return (await requestAsPromise(tx.objectStore(STORE_RECORDS).get(id))) || null;
  }

  async all() {
    const tx = this.db.transaction(STORE_RECORDS, "readonly");
    const rows = await requestAsPromise(tx.objectStore(STORE_RECORDS).getAll());
    return rows.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  }

  async byStatus(statuses) {
    const wanted = new Set(statuses);
    return (await this.all()).filter((r) => wanted.has(r.sync.status));
  }

  async update(id, mutate) {
    const record = await this.get(id);
    if (!record) return null;
    const next = mutate(record) || record;
    await this.put(next);
    return next;
  }

  /** Only ever advance a record's queue position; never rewind it. */
  async advance(id, status, patch = {}) {
    return this.update(id, (record) => {
      if (RANK[status] !== undefined && RANK[record.sync.status] !== undefined
        && RANK[status] < RANK[record.sync.status]) {
        return record;
      }
      record.sync = { ...record.sync, ...patch, status };
      return record;
    });
  }

  async remove(id) {
    const record = await this.get(id);
    const tx = this.db.transaction(STORE_RECORDS, "readwrite");
    tx.objectStore(STORE_RECORDS).delete(id);
    await txDone(tx);
    if (record) await this.deleteEvidence(evidenceKeys(record));
  }

  async counts() {
    const rows = await this.all();
    const byStatus = {};
    for (const row of rows) byStatus[row.sync.status] = (byStatus[row.sync.status] || 0) + 1;
    return { total: rows.length, byStatus };
  }

  async queueDepth() {
    const ready = await this.byStatus([STATUS.VERIFIED, STATUS.QUEUED]);
    const review = await this.byStatus([STATUS.NEEDS_REVIEW, STATUS.DRAFT]);
    const stuck = await this.byStatus([STATUS.FAILED, STATUS.CONFLICT]);
    return { ready: ready.length, review: review.length, stuck: stuck.length };
  }
}

export function evidenceKeys(record) {
  const keys = (record.evidence?.items || []).map((i) => i.storageKey);
  if (record.evidence?.audioKey) keys.push(record.evidence.audioKey);
  return keys.filter(Boolean);
}

/** Turn a stored record into the wire form the desktop inbox receives. */
export async function toWireEntry(store, record) {
  const evidence = [];
  for (const item of record.evidence?.items || []) {
    const blob = await store.getEvidence(item.storageKey);
    if (!blob) continue;
    evidence.push({
      name: item.name,
      mime: item.mime,
      sha256: item.sha256,
      bytes: blob.blob.size,
      base64: await blobToBase64(blob.blob),
    });
  }
  if (record.evidence?.audioKey) {
    const blob = await store.getEvidence(record.evidence.audioKey);
    if (blob) {
      evidence.push({
        name: "narration.webm",
        mime: blob.mime || "audio/webm",
        sha256: record.evidence.audioSha256,
        bytes: blob.blob.size,
        base64: await blobToBase64(blob.blob),
      });
    }
  }
  const { evidence: evidenceSummary, ...rest } = record;
  return {
    record: { ...rest, evidence: { photoCount: evidenceSummary.photoCount, audioMs: evidenceSummary.audioMs, sha256: evidenceSummary.sha256 } },
    evidence,
  };
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Deterministic idempotency key.
 *
 * It hashes what was captured, not when. If the phone re-sends the same record
 * after a dropped connection the desktop recognises it and does not create a
 * second ERP row. A genuinely corrected record has different content and so
 * gets a different key, which is what turns "re-sync" into a reviewable
 * conflict instead of a silent overwrite.
 */
export async function idempotencyKey(record) {
  const canonical = JSON.stringify({
    id: record.id,
    kind: record.kind,
    capturedAt: record.capturedAt,
    capture: record.capture,
    fields: record.extraction.fields,
    evidence: record.evidence.sha256,
    review: record.sync.reviewedBy ? record.sync.reviewedBy : null,
  });
  return `sha256:${await sha256Hex(new TextEncoder().encode(canonical))}`;
}
