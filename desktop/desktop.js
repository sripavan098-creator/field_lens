/**
 * FieldLens desktop shell - the Flow State Guardian.
 *
 * Step 5 of the build brief. The problem it solves is not file transfer, it is
 * the twenty minutes of context reconstruction after one: digging through a
 * Downloads folder, remembering which shelf you were standing in front of,
 * reloading the ERP screen you had open.
 *
 * So this shell does the opposite. It watches for an Office Kit transfer to
 * land and, the moment one does, it puts the worker back on the record they
 * were last working on and lays out the rest of the incoming batch beside it.
 * The worker's job is to look at the evidence and confirm; the shell never
 * writes a row into the ERP on its own.
 */

/**
 * The inbox is a process on the worker's own machine, so loopback is the only
 * honest default. Trusting location.origin would make a copy of this shell
 * served from anywhere else (a static host, a shared drive) poll that origin
 * forever and report a missing /api/queue as though the office machine were at
 * fault. The origin is used only when this page is itself being served from
 * loopback; otherwise the worker is pointed at their own machine, and the base
 * field below lets them override it. Browsers treat http://127.0.0.1 as a
 * trustworthy origin, so this still works from an https page.
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
const DEFAULT_BASE = LOOPBACK.test(location.hostname)
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:12000";

const state = {
  base: DEFAULT_BASE,
  flow: null,
  etag: null,
  polling: null,
  lastBatchId: null,
  handover: null,
  focusLostAt: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

const POLL_MS = 3000;

function setStatus(text, tone = "idle") {
  const box = $("#status");
  box.textContent = text;
  box.dataset.tone = tone;
}

async function api(path, options) {
  const response = await fetch(`${state.base}${path}`, { cache: "no-store", ...options });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

/* ------------------------------------------------------------------ */
/* Flow State                                                          */
/* ------------------------------------------------------------------ */

async function poll() {
  try {
    const flow = await api("/api/queue");
    applyFlow(flow);
    setStatus(`Watching ${state.base} · checked every ${POLL_MS / 1000}s`, "ok");
  } catch (err) {
    setStatus(`Cannot reach the FieldLens inbox at ${state.base}: ${err.message} (${baseHint()})`, "error");
  }
}

function baseHint() {
  let host;
  try {
    host = new URL(state.base).hostname;
  } catch {
    return "that is not a valid address - enter host:port for the machine running the server";
  }
  return LOOPBACK.test(host)
    ? "is the FieldLens server running on this machine?"
    : "no FieldLens inbox answers there - check the Inbox field is your own machine, not this page's address";
}

function applyFlow(flow) {
  const previous = state.flow;
  state.flow = flow;

  const isNewTransfer = flow.batchId && flow.batchId !== (previous?.batchId ?? null);
  if (isNewTransfer) {
    announceHandover(flow, previous);
  }

  render.active(flow.active);
  render.continuation(flow);
  render.review(flow);
  render.transferMeta(flow);

  if (!flow.active && !flow.continuation.length && !flow.pendingReview.length) {
    $("#empty").hidden = false;
  } else {
    $("#empty").hidden = true;
  }
}

function announceHandover(flow, previous) {
  const record = flow.active;
  $("#handover").hidden = false;
  $("#handover-title").textContent = record
    ? `Transfer received. Reopening ${describe(record)}.`
    : "Transfer received, but every record in it needs review.";
  $("#handover-detail").textContent = [
    `${flow.continuation.length} more record(s) queued behind it.`,
    flow.pendingReview.length ? `${flow.pendingReview.length} flagged for review - not written to the ERP.` : null,
    flow.minutesSinceTransfer != null ? `Landed ${flow.minutesSinceTransfer} minute(s) ago from ${flow.deviceId}.` : null,
  ].filter(Boolean).join(" ");

  if (previous?.batchId && previous.batchId !== flow.batchId) {
    setStatus("New Office Kit transfer landed; context switched to the newest batch.", "ok");
  }
  // Deliberately no auto-scroll past the banner: the point is to restore the
  // worker's view, not to shove new content at them.
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const PROFILES = {
  invoice: [
    ["vendor", "Vendor"], ["invoiceNumber", "Invoice number"], ["invoiceDate", "Invoice date"],
    ["dueDate", "Due date"], ["currency", "Currency"], ["subtotal", "Subtotal"],
    ["tax", "Tax"], ["total", "Total"], ["poNumber", "PO number"], ["lineItemCount", "Line items"],
  ],
  inspection: [
    ["assetId", "Asset"], ["defectClass", "Defect"], ["severity", "Severity"],
    ["location", "Location"], ["immediateAction", "Immediate action"], ["partReference", "Part"],
    ["nextInspectionDays", "Reinspect in (days)"],
  ],
  inventory: [
    ["sku", "SKU"], ["description", "Description"], ["quantity", "Quantity"],
    ["unit", "Unit"], ["bin", "Bin"], ["condition", "Condition"],
  ],
};

function describe(record) {
  const fields = record.record.extraction.fields;
  const label = { invoice: "invoice", inspection: "inspection", inventory: "stock count" }[record.kind] || record.kind;
  const headline = fields.invoiceNumber || fields.assetId || fields.sku || fields.vendor || record.id.slice(0, 8);
  return `${label} ${headline}`;
}

const render = {
  active(record) {
    const panel = $("#active");
    if (!record) {
      panel.replaceChildren(el("p", { className: "meta", textContent: "No active record yet. It appears here the instant an Office Kit bundle lands." }));
      return;
    }
    const fields = record.record.extraction.fields;
    const specs = PROFILES[record.kind] || [];
    const rows = specs.map(([key, label]) => {
      const value = fields[key];
      const source = record.record.extraction.fieldSources?.[key];
      return el("div", { className: `erp-row ${value == null ? "empty" : ""}` },
        el("span", { className: "erp-key", textContent: label }),
        el("strong", { className: "erp-val", textContent: value == null ? "—" : String(value) }),
        el("span", { className: "erp-src", textContent: source ? `${source}` : "" }),
      );
    });

    panel.replaceChildren(
      el("div", { className: "active-head" },
        el("div", {},
          el("h3", { textContent: describe(record) }),
          el("p", { className: "meta", textContent: `${new Date(record.capturedAt).toLocaleString()} · captured offline on ${record.record.provenance.deviceId} · extracted by ${record.record.extraction.engine}` }),
        ),
        el("span", { className: `pill ${record.needsReview ? "review" : "clean"}`, textContent: record.needsReview ? "needs review" : `confidence ${Math.round(record.confidence * 100)}%` }),
      ),
      el("p", { className: "narrative", textContent: record.record.narrative || record.record.capture.narration }),
      el("p", { className: "meta", textContent: `Operator said: "${record.record.capture.narration}"` }),
      el("div", { className: "erp" }, ...rows),
      el("div", { className: "actions" },
        el("button", { className: "primary", textContent: "Continue here (mark as the active record)", onclick: () => touch(record, "resumed") }),
        el("button", { textContent: record.needsReview ? "Accept as-is into ERP" : "Re-confirm in ERP", onclick: () => touch(record, "confirmed") }),
        el("button", { className: "ghost", textContent: record.needsReview ? "Keep flagged for review" : "Flag for review", onclick: () => touch(record, "flagged") }),
      ),
    );
  },

  continuation(flow) {
    const list = $("#continuation");
    const records = flow.continuation || [];
    list.replaceChildren(...records.map((record) =>
      el("li", {},
        el("button", { className: "row", onclick: () => touch(record, "opened") },
          el("span", { className: "row-title", textContent: describe(record) }),
          el("span", { className: "row-sum", textContent: summarise(record) }),
          el("span", { className: `pill ${record.needsReview ? "review" : "clean"}`, textContent: record.needsReview ? "review" : "clean" }),
        ))));
    $("#continuation-count").textContent = records.length;
  },

  review(flow) {
    const list = $("#review-list");
    const records = flow.pendingReview || [];
    list.replaceChildren(...records.map((record) =>
      el("li", {},
        el("span", { className: "row-title", textContent: describe(record) }),
        el("span", { className: "row-sum", textContent: `${summarise(record)} · ${record.record.extraction.missingRequired?.join(", ") || "low confidence"}` }),
        el("span", { className: "meta", textContent: "held out of the ERP until a human confirms" }),
      )));
    $("#review-count").textContent = records.length;
  },

  transferMeta(flow) {
    const box = $("#transfer-meta");
    if (!flow.batchId) {
      box.textContent = "No transfer has landed on this desktop yet.";
      return;
    }
    box.textContent = `Batch ${flow.batchId.slice(0, 10)} from ${flow.deviceId} (code ${flow.fingerprint}) landed ${flow.receivedAt ? new Date(flow.receivedAt).toLocaleTimeString() : "just now"}.`;
    if (flow.stale) {
      box.textContent += " This transfer is old enough that resuming it may not be what you want - check the batch id.";
    }
  },
};

function summarise(record) {
  const fields = record.record.extraction.fields;
  const entries = Object.entries(fields).filter(([, v]) => v != null);
  if (!entries.length) return "no fields read";
  return entries.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(", ") + (entries.length > 3 ? ` +${entries.length - 3}` : "");
}

/** Tell the inbox which record the worker is on. This is what makes
 *  "most recently active" a fact rather than an inference. */
async function touch(record, action) {
  try {
    const response = await api(`/api/inbox/${encodeURIComponent(record.id)}/touch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note: `desktop:${action}` }),
    });
    state.flow = response.flowState;
    applyFlow(response.flowState);
  } catch (err) {
    setStatus(`Could not mark the record as active: ${err.message}`, "error");
  }
}

/* ------------------------------------------------------------------ */
/* Focus-loss detection: the "deep work destroyed" signal              */
/* ------------------------------------------------------------------ */

function wireFocusWatch() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      state.focusLostAt = Date.now();
    } else if (state.focusLostAt) {
      const away = Math.round((Date.now() - state.focusLostAt) / 1000);
      state.focusLostAt = null;
      if (away > 90) {
        $("#resume-banner").hidden = false;
        $("#resume-detail").textContent = `You were away ${away}s. The active record below is where you left it, and the batch is unchanged.`;
      }
    }
  });
  $("#dismiss-resume").addEventListener("click", () => { $("#resume-banner").hidden = true; });
  $("#dismiss-handover").addEventListener("click", () => { $("#handover").hidden = true; });
}

/* ------------------------------------------------------------------ */

async function boot() {
  $("#base").value = state.base;
  $("#base-url").textContent = state.base;
  wireFocusWatch();
  $("#refresh").addEventListener("click", poll);
  $('#base').addEventListener("change", (event) => {
    state.base = (event.target.value || DEFAULT_BASE).replace(/\/+$/, "");
    $("#base-url").textContent = state.base;
    state.flow = null;
    poll();
  });
  await poll();
  state.polling = setInterval(poll, POLL_MS);
}

boot().catch((err) => setStatus(`Desktop shell failed to start: ${err.message}`, "error"));
