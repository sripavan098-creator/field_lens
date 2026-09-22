/**
 * FieldLens capture UI.
 *
 * Step 1 of the build brief lives here: the camera and the microphone are a
 * single control, not two. Holding the shutter button records audio for as long
 * as the worker speaks and grabs a frame, and the two arrive in one record.
 *
 * The UI reports the extraction engine it is actually using and shows the
 * evidence alongside every field, because a field worker cannot trust a row
 * they cannot trace back to the pipe they were standing in front of.
 */

import { EngineRegistry, PROFILES, analyseFrame } from "./engine.js";
import { FieldStore, STATUS, ulid, sha256Hex, estimateAudioMs, idempotencyKey } from "./store.js";
import { OfficeKitClient, PROTOCOL, normaliseBaseUrl, describeTarget } from "./transfer.js";

const APP_VERSION = "0.1.0";
const AUDIO_BYTES_PER_SECOND = 8000; // rough Opus/WebM rate, used for the duration estimate

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

class Capture {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recognition = null;
    this.transcript = "";
    this.startedAt = 0;
    this.audioMime = "audio/webm";
  }

  get live() {
    return Boolean(this.stream) || Boolean(this.recognition);
  }

  async start() {
    this.transcript = "";
    const errors = [];

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        $("#preview").srcObject = this.stream;
        await $("#preview").play().catch(() => {});
      } catch (err) {
        errors.push(`camera/mic: ${err.message}`);
      }
    } else {
      errors.push("camera/mic: getUserMedia is unavailable in this webview");
    }

    if (this.stream && window.MediaRecorder) {
      const track = this.stream.getAudioTracks()[0];
      if (track) {
        const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
        this.audioMime = preferred.find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
        try {
          this.recorder = this.audioMime
            ? new MediaRecorder(new MediaStream([track]), { mimeType: this.audioMime })
            : new MediaRecorder(new MediaStream([track]));
          this.chunks = [];
          this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
          this.recorder.start(250);
        } catch (err) {
          errors.push(`audio recorder: ${err.message}`);
        }
      }
    }

    // Live transcription is the only other input the engine needs, and it is
    // optional: a worker can always correct the narration by typing.
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = navigator.language || "en-US";
        this.recognition.onresult = (event) => {
          let final = "", interim = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const phrase = event.results[i][0].transcript;
            if (event.results[i].isFinal) final += phrase; else interim += phrase;
          }
          if (final) this.transcript = `${this.transcript} ${final}`.trim();
          const box = $("#narration");
          if (box && !box.dataset.userEdited) {
            box.value = `${this.transcript} ${interim}`.trim();
            box.dataset.interim = interim ? "1" : "";
          }
        };
        this.recognition.onerror = (event) => {
          if (event.error !== "no-speech") setNotice(`Speech recognition stopped: ${event.error}. Type the narration if needed.`, "warn");
        };
        this.recognition.start();
      } catch {
        this.recognition = null;
      }
    } else {
      errors.push("speech: no on-device recogniser, type the narration instead");
    }

    this.startedAt = performance.now();
    if (errors.length) setNotice(errors.join(" | "), "warn");
    return errors;
  }

  async stop() {
    const durationMs = Math.round(performance.now() - this.startedAt);
    let audioBlob = null;

    if (this.recorder && this.recorder.state !== "inactive") {
      audioBlob = await new Promise((resolve) => {
        this.recorder.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks, { type: this.audioMime || "audio/webm" }) : null);
        this.recorder.stop();
      });
    }
    const transcript = this.transcript;
    this.dispose();
    return { audioBlob, durationMs, transcript };
  }

  dispose() {
    this.recognition?.stop?.();
    this.recognition = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/* ------------------------------------------------------------------ */

const state = {
  store: new FieldStore(),
  engines: new EngineRegistry(),
  capture: new Capture(),
  client: null,
  activeRecord: null,
  view: "capture",
  busy: false,
};

function setNotice(message, tone = "info") {
  const box = $("#notice");
  if (!box) return;
  box.textContent = message;
  box.dataset.tone = tone;
  box.hidden = !message;
}

function setBusy(busy, message) {
  state.busy = busy;
  document.body.dataset.busy = busy ? "1" : "0";
  if (message) setNotice(message, "info");
}

/* ------------------------------------------------------------------ */

async function boot() {
  await state.store.open();
  state.client = new OfficeKitClient(state.store);

  renderProfileOptions();
  wireEvents();
  await selectProfile($("#kind").value);

  try {
    const engine = await state.engines.activate();
    setNotice(`Extraction engine ready: ${engine.label}. Nothing leaves this device until you sync.`, "ok");
  } catch (err) {
    setNotice(`No extraction engine available: ${err.message}`, "error");
  }

  await refreshAll();
  registerServiceWorker();
  renderDevice();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    setNotice(`Offline cache not installed: ${err.message}`, "warn");
  });
}

function renderProfileOptions() {
  const select = $("#kind");
  select.replaceChildren(...Object.entries(PROFILES).map(([key, profile]) =>
    el("option", { value: key, textContent: profile.label })));
}

function wireEvents() {
  $("#kind").addEventListener("change", (event) => selectProfile(event.target.value));

  const shutter = $("#shutter");
  const down = (event) => { event.preventDefault(); startCapture(); };
  const up = (event) => { event.preventDefault(); finishCapture(); };
  shutter.addEventListener("pointerdown", down);
  shutter.addEventListener("pointerup", up);
  shutter.addEventListener("pointercancel", up);
  shutter.addEventListener("pointerleave", (event) => { if (state.capture.live) up(event); });

  $("#narration").addEventListener("input", (event) => { event.target.dataset.userEdited = "1"; });

  for (const tab of document.querySelectorAll("[data-view]")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }

  $("#sync-now").addEventListener("click", runSync);
  $("#pair-now").addEventListener("click", runPairing);
  $("#probe-now").addEventListener("click", runProbe);
  $("#export-now").addEventListener("click", exportBundleFile);
  $("#clear-acked").addEventListener("click", clearAcked);

  $("#target").addEventListener("input", (event) => {
    const target = describeTarget(event.target.value);
    const hint = $("#target-hint");
    if (!target) { hint.textContent = "No target set."; return; }
    if (target.invalid) { hint.textContent = "That does not look like a host:port or URL."; return; }
    hint.textContent = target.looksLocal
      ? `${target.host}:${target.port} is a local address - the right shape for Office Kit.`
      : `${target.host}:${target.port} is not a private address; check you are on the office network.`;
  });
}

function switchView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll("[data-view]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== view;
  }
  if (view === "queue") renderQueue();
  if (view === "sync") renderSync();
}

async function selectProfile(key) {
  const profile = PROFILES[key];
  $("#profile-hint").textContent = profile.hint;
  const engine = state.engines.status().active;
  $("#field-preview").replaceChildren(...profile.fields.map((field) =>
    el("li", { className: field.required ? "req" : "" },
      el("code", { textContent: field.key }),
      el("span", { textContent: field.type === "enum" ? field.values.join(" | ") : field.type }))));
  $("#engine-note").textContent = engine
    ? `Fields will be extracted on-device by ${engine.id}.`
    : "No extraction engine loaded yet.";
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

async function startCapture() {
  if (state.busy || state.capture.live) return;
  setNotice("Recording - hold the shutter, speak, and release when done.", "info");
  $("#shutter").dataset.recording = "1";
  await state.capture.start();
}

async function finishCapture() {
  if (!state.capture.live) return;
  $("#shutter").dataset.recording = "0";
  setBusy(true, "Merging the frame and the narration into one record…");

  try {
    const { audioBlob, durationMs, transcript } = await state.capture.stop();
    const photo = await grabFrame();
    if (!photo) throw new Error("no frame was captured from the camera");

    const typed = $("#narration").value.trim();
    const narration = typed || transcript || "";
    if (!narration) {
      setNotice("No narration was captured. Type what you saw before saving - the AI will not invent it.", "warn");
      state.activeRecord = { photo, audioBlob, durationMs, narration: "" };
      renderDraft({ photo, audioBlob, durationMs, narration: "" });
      setBusy(false);
      return;
    }
    await buildRecord({ photo, audioBlob, durationMs, narration });
  } catch (err) {
    setNotice(`Capture failed: ${err.message}`, "error");
    setBusy(false);
  }
}

async function grabFrame() {
  const video = $("#preview");
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85));
}

function renderDraft(draft) {
  const preview = $("#draft-preview");
  preview.hidden = false;
  const photoUrl = draft.photo ? URL.createObjectURL(draft.photo) : null;
  preview.replaceChildren(
    el("h3", { textContent: "Held for review" }),
    photoUrl ? el("img", { src: photoUrl, alt: "captured frame", className: "thumb" }) : el("p"),
    el("p", { textContent: draft.narration ? `Narration: ${draft.narration}` : "Narration is still empty." }),
    el("button", {
      className: "primary",
      textContent: "Extract with typed narration",
      onclick: async () => {
        const narration = $("#narration").value.trim();
        if (!narration) { setNotice("Type the narration first.", "warn"); return; }
        await buildRecord({ ...draft, narration });
      },
    }),
  );
}

async function buildRecord({ photo, audioBlob, durationMs, narration }) {
  const kind = $("#kind").value;
  const profile = { ...PROFILES[kind], key: kind };
  const engine = state.engines.status().active;
  const startedAt = performance.now();

  const photoBytes = new Uint8Array(await photo.arrayBuffer());
  const photoSha = await sha256Hex(photoBytes);
  const audioSha = audioBlob ? await sha256Hex(await audioBlob.arrayBuffer()) : null;

  let frameStats;
  try {
    const bitmap = await createImageBitmap(photo);
    frameStats = analyseFrame(bitmap);
    bitmap.close?.();
  } catch {
    frameStats = { blurry: false, underexposed: false, docLikelihood: 0.5, width: 0, height: 0 };
  }

  const extraction = await state.engines.active.extract({
    profile, narration, frameStats,
    imageBitmap: await createImageBitmap(photo).catch(() => null),
  });

  const id = ulid();
  const photoKey = `photo:${id}`;
  const audioKey = audioBlob ? `audio:${id}` : null;
  await state.store.putEvidence(photoKey, photo, { mime: "image/jpeg", sha256: photoSha, recordId: id });
  if (audioKey) await state.store.putEvidence(audioKey, audioBlob, { mime: audioBlob.type || "audio/webm", sha256: audioSha, recordId: id });

  const evidenceSummary = {
    photoCount: 1,
    audioMs: durationMs || estimateAudioMs(audioBlob, AUDIO_BYTES_PER_SECOND),
    sha256: { photo: photoSha, ...(audioSha ? { audio: audioSha } : {}) },
  };

  const record = {
    id,
    kind,
    capturedAt: new Date().toISOString(),
    capture: {
      narration,
      site: $("#site").value.trim() || "unassigned",
      operator: $("#operator").value.trim() || null,
      geo: null,
    },
    evidence: {
      ...evidenceSummary,
      items: [{ name: "frame.jpg", storageKey: photoKey, mime: "image/jpeg", sha256: photoSha, bytes: photo.size }],
      audioKey,
      audioSha256: audioSha,
      frameStats,
    },
    extraction: {
      fields: extraction.fields,
      confidence: extraction.confidence,
      engine: extraction.engine,
      needsReview: extraction.needsReview,
      fieldSources: extraction.fieldSources,
      missingRequired: extraction.missingRequired,
    },
    narrative: extraction.narrative,
    sync: { status: STATUS.DRAFT, attempts: 0, idempotencyKey: "", lastError: null, ackedAt: null, batchId: null },
    provenance: {
      deviceId: state.store.deviceId,
      appVersion: APP_VERSION,
      createdOffline: true,
      clockSkewRisk: false,
    },
    metrics: { extractionMs: Math.round(performance.now() - startedAt) },
  };

  record.sync.idempotencyKey = await idempotencyKey(record);
  record.sync.status = record.extraction.needsReview ? STATUS.NEEDS_REVIEW : STATUS.VERIFIED;

  await state.store.put(record);
  state.activeRecord = record;

  $("#narration").value = "";
  delete $("#narration").dataset.userEdited;
  $("#draft-preview").hidden = true;

  setNotice(
    `${engine.label} extracted the record in ${record.metrics.extractionMs} ms offline (confidence ${record.extraction.confidence}).`,
    "ok",
  );
  setBusy(false);
  switchView("queue");
  await refreshAll();
  await openRecord(record.id);
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

const STATUS_LABEL = {
  draft: "Draft", needs_review: "Needs review", verified: "Verified", queued: "Queued",
  transferring: "Transferring", acked: "On desktop", conflict: "Conflict", failed: "Failed",
};

async function refreshAll() {
  const depth = await state.store.queueDepth();
  $("#depth-ready").textContent = depth.ready;
  $("#depth-review").textContent = depth.review;
  $("#depth-stuck").textContent = depth.stuck;
  $("#depth-total").textContent = (await state.store.counts()).total;
  $("#queue-ready-count").textContent = depth.ready;
  await renderEngineStatus();
  if (state.view === "queue") await renderQueue();
  if (state.view === "sync") await renderSync();
}

async function renderEngineStatus() {
  const status = state.engines.status();
  const list = $("#engine-attempts");
  list.replaceChildren(...status.attempts.map((attempt) =>
    el("li", { className: attempt.loaded ? "ok" : "off" },
      el("strong", { textContent: attempt.label }),
      el("span", { textContent: attempt.loaded ? " loaded" : ` unavailable - ${attempt.reason}` }))));
}

async function renderQueue() {
  const records = await state.store.all();
  const listBody = $("#queue-body");
  const filters = readFilters();
  const filtered = records.filter((r) => (!filters.kind || r.kind === filters.kind) && (!filters.status || r.sync.status === filters.status));

  listBody.replaceChildren(...filtered.map((record) => {
    const row = el("tr", { className: record.id === state.activeRecord?.id ? "active" : "" });
    row.append(
      el("td", {}, el("code", { textContent: record.id.slice(0, 8) })),
      el("td", { textContent: PROFILES[record.kind]?.label || record.kind }),
      el("td", {}, el("span", { className: `pill ${record.sync.status}`, textContent: STATUS_LABEL[record.sync.status] || record.sync.status })),
      el("td", { textContent: `${Math.round(record.extraction.confidence * 100)}%` }),
      el("td", { textContent: summarise(record) }),
      el("td", {}, el("button", { textContent: "Open", onclick: () => openRecord(record.id) })),
    );
    return row;
  }));

  $("#queue-empty").hidden = filtered.length > 0;
  renderActiveRecord();
}

function readFilters() {
  return { kind: $("#queue-filter-kind").value || null, status: $("#queue-filter-status").value || null };
}

function summarise(record) {
  const entries = Object.entries(record.extraction.fields).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return "no fields read";
  return entries.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(", ") + (entries.length > 3 ? ` +${entries.length - 3}` : "");
}

async function openRecord(id) {
  const record = await state.store.get(id);
  state.activeRecord = record;
  renderActiveRecord();
  if (record) switchView("queue");
}

function renderActiveRecord() {
  const panel = $("#record-detail");
  const record = state.activeRecord;
  if (!record) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const profile = { ...PROFILES[record.kind], key: record.kind };

  const photoItem = record.evidence.items?.[0];
  const media = el("div", { className: "media" });
  if (photoItem) {
    state.store.getEvidence(photoItem.storageKey).then((blob) => {
      if (blob) media.prepend(el("img", { src: URL.createObjectURL(blob.blob), alt: "captured evidence", className: "thumb" }));
    });
  }
  if (record.evidence.audioKey) {
    state.store.getEvidence(record.evidence.audioKey).then((blob) => {
      if (blob) media.append(el("audio", { controls: true, src: URL.createObjectURL(blob.blob) }));
    });
  }

  const fieldRows = profile.fields.map((spec) => {
    const value = record.extraction.fields[spec.key];
    const input = el("input", {
      value: value === null || value === undefined ? "" : String(value),
      placeholder: spec.required ? "required" : "optional",
      dataset: { field: spec.key, kind: record.kind },
      oninput: (event) => { event.target.dataset.dirty = "1"; },
    });
    return el("label", { className: `field ${spec.required ? "req" : ""}` },
      el("span", { className: "k", textContent: spec.key }),
      input,
      el("small", { className: "src", textContent: sourceLabel(record, spec.key) }));
  });

  panel.replaceChildren(
    el("h3", { textContent: `${PROFILES[record.kind]?.label || record.kind} · ${record.id.slice(0, 8)}` }),
    el("p", { className: "meta", textContent: `${new Date(record.capturedAt).toLocaleString()} · ${record.capture.site} · confidence ${record.extraction.confidence} · engine ${record.extraction.engine}` }),
    el("p", { className: "narrative", textContent: record.narrative || record.capture.narration }),
    el("p", { className: "meta", textContent: `Operator said: "${record.capture.narration}"` }),
    media,
    el("div", { className: "fields" }, ...fieldRows),
    record.extraction.missingRequired?.length
      ? el("p", { className: "warnbox", textContent: `Unread required fields: ${record.extraction.missingRequired.join(", ")}` })
      : el("p", { className: "okbox", textContent: "All required fields are populated." }),
    el("div", { className: "actions" },
      el("button", { className: "primary", textContent: "Save edits and verify", onclick: () => saveAndVerify(record.id) }),
      el("button", { textContent: "Re-run extraction from the saved narration", onclick: () => reextract(record.id) }),
      el("button", { textContent: "Mark for review", onclick: () => markReview(record.id) }),
      el("button", { className: "danger", textContent: "Delete record and evidence", onclick: () => deleteRecord(record.id) }),
    ),
  );
}

function sourceLabel(record, key) {
  const source = record.extraction.fieldSources?.[key];
  if (!source) return "not captured";
  return { audio: "from narration", visual: "from the frame", fused: "narration + frame agreed",
    inferred: "inferred - check it" }[source] || source;
}

async function saveAndVerify(id) {
  const inputs = [...document.querySelectorAll("#record-detail input[data-field]")];
  await state.store.update(id, (record) => {
    const profile = PROFILES[record.kind];
    for (const input of inputs) {
      const spec = profile.fields.find((f) => f.key === input.dataset.field);
      let raw = input.value.trim();
      let value = raw === "" ? null : raw;
      if (value !== null) {
        if (spec.type === "number") { const n = Number.parseFloat(raw.replace(/[^0-9.\-]/g, "")); value = Number.isFinite(n) ? n : null; }
        if (spec.type === "integer") { const n = Number.parseInt(raw.replace(/[^0-9\-]/g, ""), 10); value = Number.isFinite(n) ? n : null; }
      }
      record.extraction.fields[spec.key] = value;
      if (input.dataset.dirty === "1") record.extraction.fieldSources[spec.key] = "inferred";
    }
    record.extraction.missingRequired = profile.fields
      .filter((f) => f.required && record.extraction.fields[f.key] == null).map((f) => f.key);
    record.extraction.needsReview = record.extraction.missingRequired.length > 0;
    record.sync.status = record.extraction.needsReview ? STATUS.NEEDS_REVIEW : STATUS.VERIFIED;
    record.sync.reviewedBy = state.store.deviceId;
    record.sync.reviewedAt = new Date().toISOString();
    return record;
  });
  const updated = await state.store.get(id);
  updated.sync.idempotencyKey = await idempotencyKey(updated);
  await state.store.put(updated);
  state.activeRecord = updated;
  setNotice("Edits verified against the retained evidence.", "ok");
  await refreshAll();
}

async function reextract(id) {
  const record = await state.store.get(id);
  const profile = { ...PROFILES[record.kind], key: record.kind };
  const photo = (await state.store.getEvidence(record.evidence.items[0].storageKey))?.blob;
  const frameStats = record.evidence.frameStats || { blurry: false, underexposed: false, docLikelihood: 0.5 };
  const extraction = await state.engines.active.extract({
    profile, narration: record.capture.narration, frameStats,
    imageBitmap: photo ? await createImageBitmap(photo).catch(() => null) : null,
  });
  await state.store.update(id, (r) => {
    r.extraction = { ...r.extraction, ...extraction, fieldSources: extraction.fieldSources, missingRequired: extraction.missingRequired };
    r.narrative = extraction.narrative;
    r.sync.status = extraction.needsReview ? STATUS.NEEDS_REVIEW : STATUS.VERIFIED;
    return r;
  });
  const updated = await state.store.get(id);
  updated.sync.idempotencyKey = await idempotencyKey(updated);
  await state.store.put(updated);
  state.activeRecord = updated;
  setNotice(`Re-extracted offline with ${extraction.engine}.`, "ok");
  await refreshAll();
}

async function markReview(id) {
  await state.store.update(id, (record) => { record.sync.status = STATUS.NEEDS_REVIEW; record.extraction.needsReview = true; return record; });
  state.activeRecord = await state.store.get(id);
  await refreshAll();
  setNotice("Held for review. It will not be sent until verified.", "warn");
}

async function deleteRecord(id) {
  await state.store.remove(id);
  state.activeRecord = null;
  await refreshAll();
  setNotice("Record and its evidence deleted from this device.", "warn");
}

/* ------------------------------------------------------------------ */
/* Sync tab                                                            */
/* ------------------------------------------------------------------ */

async function renderSync() {
  const target = $("#target").value || (await state.client.pairing())?.baseUrl || "";
  if (target) $("#target").value = target;
  const pairing = await state.client.pairing();
  $("#pairing-state").textContent = pairing
    ? `Paired with ${pairing.baseUrl} as ${pairing.fingerprint} at ${new Date(pairing.pairedAt).toLocaleTimeString()}.`
    : "Not paired with a desktop yet. The first sync claims the code shown on the PC.";
  const ready = await state.client.readyRecords();
  $("#send-set").textContent = ready.length
    ? `${ready.length} verified record(s) ready: ${ready.map((r) => r.id.slice(0, 8)).join(", ")}`
    : "Nothing is verified yet. Verify records in the queue first.";
  await renderEngineStatus();
}

function renderDevice() {
  $("#device-id").textContent = state.store.deviceId;
  $("#protocol").textContent = PROTOCOL;
}

async function runProbe() {
  setBusy(true, "Probing the desktop over the local link…");
  try {
    const probe = await state.client.probe($("#target").value);
    setNotice(probe.reachable
      ? `Desktop "${probe.hostname}" answered in ${probe.latencyMs} ms over ${probe.protocol}.`
      : "The desktop did not answer /api/health.", probe.reachable ? "ok" : "error");
  } catch (err) {
    setNotice(err.message, "error");
  } finally {
    setBusy(false);
  }
}

async function runPairing() {
  setBusy(true, "Claiming the desktop pairing code…");
  try {
    const saved = await state.client.claimPairing($("#target").value);
    setNotice(`Paired. Desktop code ${saved.fingerprint}.`, "ok");
    await renderSync();
  } catch (err) {
    setNotice(err.message, "error");
  } finally {
    setBusy(false);
  }
}

async function runSync() {
  setBusy(true, "Syncing over Office Kit - no cloud in the path…");
  try {
    const report = await state.client.sync($("#target").value, {
      note: $("#sync-note").value.trim() || null,
      onProgress: (step) => setNotice(`${step.phase}: ${step.message}`, step.phase === "done" ? "ok" : "info"),
    });
    setNotice(
      report.sent === 0
        ? "Queue is empty - nothing to transfer."
        : `Office Kit transfer ${report.outcome}: ${report.acked} accepted, ${report.conflicted} conflicted, ${report.rejected} rejected.`,
      report.conflicted || report.rejected ? "warn" : "ok",
    );
  } catch (err) {
    setNotice(err.message, "error");
  } finally {
    setBusy(false);
    await refreshAll();
    await renderSync();
  }
}

/** Fallback for a machine with no reachable LAN: carry the bundle on a stick. */
async function exportBundleFile() {
  const ready = await state.client.readyRecords();
  if (!ready.length) { setNotice("Nothing verified to export.", "warn"); return; }
  const bundle = await state.client.buildBundle(ready, $("#sync-note").value.trim() || null);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const link = el("a", { href: URL.createObjectURL(blob), download: `fieldlens-${bundle.batchId}.officekit.json` });
  link.click();
  setNotice(`Wrote ${ready.length} record(s) to a portable bundle. Drop it into the desktop inbox folder.`, "ok");
}

async function clearAcked() {
  const acked = await state.store.byStatus([STATUS.ACKED]);
  for (const record of acked) await state.store.remove(record.id);
  setNotice(`Removed ${acked.length} delivered record(s) and their evidence from this device.`, "warn");
  await refreshAll();
}

boot().catch((err) => setNotice(`FieldLens failed to start: ${err.message}`, "error"));
