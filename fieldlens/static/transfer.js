/**
 * FieldLens Office Kit transfer.
 *
 * The phone talks to the office PC over the local network only: same Wi-Fi, a
 * USB tether, or a hotspot with no uplink. There is no cloud relay and no DNS
 * requirement, so "returning to base" is the only prerequisite for a sync.
 *
 * A transfer is one bundle containing every queued record plus its evidence.
 * The bundle carries an idempotency key per record and a stable batch id, so an
 * interrupted transfer can simply be repeated.
 */

import { STATUS, ulid, toWireEntry } from "./store.js";

export const PROTOCOL = "officekit/1";
const CLAIM_KEY = "fieldlens.pairing";

export function normaliseBaseUrl(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, "");
  return value;
}

export function describeTarget(baseUrl) {
  const url = normaliseBaseUrl(baseUrl);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost$|.*\.local$)/.test(parsed.hostname);
    return {
      url,
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      looksLocal: privateHost || parsed.hostname.endsWith(".local"),
    };
  } catch {
    return { url, host: null, port: null, looksLocal: false, invalid: true };
  }
}

export class OfficeKitClient {
  constructor(store, { timeoutMs = 45000 } = {}) {
    this.store = store;
    this.timeoutMs = timeoutMs;
  }

  /* -- pairing ----------------------------------------------------- */

  async claimPairing(baseUrl) {
    const url = normaliseBaseUrl(baseUrl);
    const deviceId = this.store.deviceId;
    const fingerprint = await this.fingerprintFor(url, deviceId);
    const response = await this.#fetch(url, "/api/pair/claim", {
      method: "POST",
      body: JSON.stringify({ deviceId, fingerprint }),
    });
    if (!response.ok) {
      const detail = await safeJson(response);
      throw new Error(detail?.error || `pairing rejected (${response.status})`);
    }
    const saved = { baseUrl: url, fingerprint, deviceId, pairedAt: new Date().toISOString() };
    await this.store.setMeta(CLAIM_KEY, saved);
    return saved;
  }

  async pairing() {
    return this.store.getMeta(CLAIM_KEY);
  }

  async fingerprintFor(baseUrl, deviceId) {
    const url = normaliseBaseUrl(baseUrl);
    const res = await this.#fetch(url, `/api/pair?device=${encodeURIComponent(deviceId)}`, { method: "GET" });
    if (!res.ok) throw new Error(`could not read pairing code from ${url} (${res.status})`);
    const data = await res.json();
    return data.fingerprint;
  }

  async probe(baseUrl) {
    const url = normaliseBaseUrl(baseUrl);
    const started = performance.now();
    const res = await this.#fetch(url, "/api/health", { method: "GET" });
    const data = await safeJson(res);
    return {
      reachable: res.ok,
      latencyMs: Math.round(performance.now() - started),
      hostname: data?.hostname,
      protocol: data?.protocol,
      inbox: data?.inbox,
    };
  }

  /* -- queue ------------------------------------------------------- */

  /** Records the worker has verified (or already queued) form the send set. */
  async readyRecords() {
    return this.store.byStatus([STATUS.VERIFIED, STATUS.QUEUED, STATUS.FAILED]);
  }

  async buildBundle(records, note) {
    const entries = [];
    for (const record of records) entries.push(await toWireEntry(this.store, record));
    const batchId = ulid();
    const pairing = await this.pairing();
    return {
      protocol: PROTOCOL,
      batchId,
      fingerprint: pairing?.fingerprint || null,
      device: { id: this.store.deviceId, platform: navigator.userAgentData?.platform || navigator.platform || "unknown" },
      manifest: {
        createdAt: new Date().toISOString(),
        note: note || null,
        recordCount: entries.length,
        kinds: [...new Set(records.map((r) => r.kind))],
        totalEvidenceBytes: entries.reduce((total, e) => total + e.evidence.reduce((s, i) => s + (i.bytes || 0), 0), 0),
        appVersion: "0.1.0",
        needsReviewCount: records.filter((r) => r.extraction.needsReview).length,
      },
      records: entries,
    };
  }

  /**
   * Send the queue.
   *
   * Records are marked transferring before the request and resolved from the
   * response one by one. If the desktop never answers, every record in the set
   * goes back to a sendable state with the reason attached, so a worker who
   * walks out of Wi-Fi range can simply try again rather than wondering which
   * records made it.
   */
  async sync(baseUrl, { onProgress = () => {}, note = null } = {}) {
    const pairing = await this.pairing();
    const base = normaliseBaseUrl(baseUrl) || pairing?.baseUrl;
    if (!base) throw new Error("no desktop target configured");

    const records = await this.readyRecords();
    if (!records.length) return { sent: 0, base, outcome: "queue-empty" };

    try {
      if (!pairing || pairing.baseUrl !== base) {
        onProgress({ phase: "pairing", message: "claiming the desktop pairing code" });
        await this.claimPairing(base);
      }

      const bundle = await this.buildBundle(records, note);
      onProgress({ phase: "preparing", message: `packing ${records.length} record(s)`, bundle });

      for (const record of records) {
        await this.store.advance(record.id, STATUS.TRANSFERRING, {
          batchId: bundle.batchId,
          attempts: record.sync.attempts + 1,
        });
      }

      onProgress({
        phase: "transferring",
        message: `sending ${(JSON.stringify(bundle).length / 1024).toFixed(0)} KB over the wire`,
        bundle,
      });

      const response = await this.#fetch(base, "/api/ingest", {
        method: "POST",
        body: JSON.stringify(bundle),
        headers: { "Content-Type": "application/json", "X-OfficeKit-Batch": bundle.batchId },
      });

      const result = await safeJson(response);
      if (!response.ok) {
        throw new Error(result?.error || `desktop refused the bundle (${response.status})`);
      }

      const byRecord = new Map();
      for (const entry of result.accepted || []) byRecord.set(entry.recordId, { verdict: "accepted", entry });
      for (const entry of result.conflicts || []) byRecord.set(entry.recordId, { verdict: "conflict", entry });
      for (const entry of result.unsupported || []) byRecord.set(entry.recordId, { verdict: "unsupported", entry });

      let acked = 0, conflicted = 0, rejected = 0, replays = 0;
      for (const record of records) {
        const outcome = byRecord.get(record.id);
        if (outcome?.verdict === "accepted") {
          const replayed = outcome.entry.storedId !== record.id || outcome.entry.reason !== "new";
          await this.store.advance(record.id, STATUS.ACKED, {
            ackedAt: new Date().toISOString(),
            lastError: null,
            desktopId: outcome.entry.storedId || record.id,
            replay: outcome.entry.reason || "new",
          });
          acked += 1;
          if (replayed) replays += 1;
        } else if (outcome?.verdict === "conflict") {
          await this.store.advance(record.id, STATUS.CONFLICT, { lastError: outcome.entry.reason });
          conflicted += 1;
        } else {
          await this.store.advance(record.id, STATUS.FAILED, {
            lastError: outcome?.entry?.reason || "the desktop did not acknowledge this record",
          });
          rejected += 1;
        }
      }

      // Reported from what the desktop actually did per record rather than the
      // batch-level status, since one batch can hold both new and replayed work.
      const outcome = conflicted || rejected
        ? "partial"
        : replays === records.length ? "already-delivered" : "delivered";
      onProgress({ phase: "done", message: `${acked} accepted, ${conflicted} conflicted, ${rejected} rejected`, result });
      return { sent: records.length, acked, conflicted, rejected, base, batchId: bundle.batchId, outcome, result };
    } catch (err) {
      await this.#returnToQueue(records, err.message);
      throw err;
    }
  }

  /**
   * Put a failed send set back in the sendable part of the queue.
   *
   * FAILED is a terminal-looking state for the worker's benefit, so a record is
   * moved back to QUEUED immediately afterwards; the error text is what tells
   * them something went wrong, not a status they would have to clear by hand.
   */
  async #returnToQueue(records, message) {
    for (const record of records) {
      await this.store.update(record.id, (r) => {
        r.sync = {
          ...r.sync,
          status: STATUS.QUEUED,
          // Count the failure here too: a transfer that dies during pairing is
          // still an attempt, and the worker needs to see it is being retried.
          attempts: (r.sync.attempts || 0) + 1,
          lastError: message,
        };
        return r;
      });
    }
  }

  async #fetch(base, path, { method = "GET", body = null, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${base}${path}`, {
        method,
        body,
        headers,
        signal: controller.signal,
        cache: "no-store",
        // The desktop is a bare local server; no cookies, no credentials.
        credentials: "omit",
        mode: "cors",
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`desktop at ${base} did not answer within ${this.timeoutMs / 1000}s`);
      throw new Error(`cannot reach the desktop at ${base} (${err.message})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
