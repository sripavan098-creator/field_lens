/**
 * FieldLens on-device extraction engine.
 *
 * Two engines implement the same contract so the app never has to know which
 * one is present:
 *
 *   Phi3VisionNpuEngine - the real target. Drives a quantised Phi-3-Vision
 *     through the host runtime on the NPU/WebGPU. It refuses to load when no
 *     runtime is present instead of pretending to be a model.
 *
 *   RulesEngine - a deterministic offline extractor. It always loads, needs no
 *     weights, and exists so a worker's record is never silently empty when a
 *     device cannot host the VLM. It reads the spoken narration and cheap
 *     visual statistics from the frame.
 *
 * The extraction profiles below are the machine-readable form of "prototype
 * your schema before compiling it on-device": the same field list, types and
 * required flags feed the phone engine, the JSON schema and the desktop inbox.
 *
 * Nothing in this file performs a network request.
 */

export const PROFILES = {
  invoice: {
    label: "Invoice / delivery note",
    hint: "Point at the document and say the vendor, number and total.",
    fields: [
      { key: "vendor", type: "text", required: true },
      { key: "invoiceNumber", type: "text", required: true },
      { key: "invoiceDate", type: "date", required: true },
      { key: "dueDate", type: "date", required: false },
      { key: "currency", type: "enum", values: ["USD", "EUR", "GBP", "INR", "AUD", "CAD"], required: false },
      { key: "subtotal", type: "number", required: false },
      { key: "tax", type: "number", required: false },
      { key: "total", type: "number", required: true },
      { key: "poNumber", type: "text", required: false },
      { key: "lineItemCount", type: "integer", required: false },
    ],
  },
  inspection: {
    label: "Infrastructure inspection",
    hint: "Point at the defect and say what it is, how bad, and where.",
    fields: [
      { key: "assetId", type: "text", required: true },
      { key: "defectClass", type: "enum", values: ["corrosion", "crack", "leak", "deformation", "blockage", "electrical", "other"], required: true },
      { key: "severity", type: "enum", values: ["low", "medium", "high", "critical"], required: true },
      { key: "location", type: "text", required: false },
      { key: "immediateAction", type: "text", required: false },
      { key: "partReference", type: "text", required: false },
      { key: "nextInspectionDays", type: "integer", required: false },
    ],
  },
  inventory: {
    label: "Warehouse shelf",
    hint: "Point at the shelf and say the SKU, quantity and bin.",
    fields: [
      { key: "sku", type: "text", required: true },
      { key: "description", type: "text", required: false },
      { key: "quantity", type: "integer", required: true },
      { key: "unit", type: "enum", values: ["each", "box", "pallet", "kg", "litre", "metre"], required: false },
      { key: "bin", type: "text", required: false },
      { key: "condition", type: "enum", values: ["sealed", "opened", "damaged", "expired"], required: false },
    ],
  },
};

export const REVIEW_THRESHOLD = 0.75;

/* ------------------------------------------------------------------ */
/* Text and number normalisation                                       */
/* ------------------------------------------------------------------ */

const CURRENCY_WORDS = {
  dollars: "USD", dollar: "USD", usd: "USD", bucks: "USD",
  euros: "EUR", euro: "EUR", eur: "EUR",
  pounds: "GBP", pound: "GBP", gbp: "GBP", sterling: "GBP",
  rupees: "INR", rupee: "INR", inr: "INR",
  aud: "AUD", cad: "CAD",
};
const CURRENCY_SYMBOLS = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR" };

const DATE_MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function normaliseMoney(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[,\s]/g, "").replace(/[^0-9.\-]/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export function normaliseDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim().toLowerCase();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (Number(d) <= 12 && Number(mo) > 12) [d, mo] = [mo, d];
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = text.match(new RegExp(`^(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+([a-z]+)\\s*(\\d{4})?$`));
  if (m && DATE_MONTHS[m[2]]) {
    const year = m[3] || String(new Date().getFullYear());
    return `${year}-${String(DATE_MONTHS[m[2]]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  }
  m = text.match(new RegExp(`^([a-z]+)\\s+(\\d{1,2})\\s*(?:st|nd|rd|th)?,?\\s*(\\d{4})?$`));
  if (m && DATE_MONTHS[m[1]]) {
    const year = m[3] || String(new Date().getFullYear());
    return `${year}-${String(DATE_MONTHS[m[1]]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  const d = new Date(text);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString().slice(0, 10);
}

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Workers say "six line items" as readily as "6 line items". Anything spoken as
 * words is only trusted for small counts; large spoken numbers are ambiguous
 * enough that a wrong guess is worse than an empty field.
 */
function wordsToNumber(fragment) {
  if (fragment == null) return null;
  const text = String(fragment).trim().toLowerCase();
  const digits = text.replace(/[^0-9]/g, "");
  if (digits) return Number.parseInt(digits, 10);
  const words = text.match(/[a-z]+/g) || [];
  if (!words.length) return null;
  let total = 0;
  let matched = false;
  for (const word of words) {
    if (NUMBER_WORDS[word] !== undefined) { total += NUMBER_WORDS[word]; matched = true; }
  }
  if (!matched) return null;
  return total > 0 ? total : null;
}

/* ------------------------------------------------------------------ */
/* Narration parsing                                                   */
/* ------------------------------------------------------------------ */

/** Words a worker uses to move from a label to its value without a comma. */
const FILLER = "(?:(?:is|are|was|were|about|approximately|around|of|at|to|please|the|a|an|total|totals|comes|then)\\s+){0,3}";
const AMOUNT = "[-+]?[$€£₹]?\\s?\\d[\\d,\\s]*(?:\\.\\d{1,2})?";
const DATE = "(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}(?:\\s+\\d{4})?|[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)";
const WORD = "[A-Za-z]+";
/** A token that cannot be a value on its own, used to reject filler matches. */
const VALUE_JUNK = /^(?:is|are|was|were|about|approximately|around|of|at|to|the|a|an|please|there|it|them|then|and|which|that|these|those|this)$/i;
/** A label word followed by a value word, used to reject one-word readings. */
const ADJACENT_LABEL = /^(?:is|are|was|were|about|approximately|around|of|at|to|the|a|an|and|which|that|these|those|this|them|with|from|for|in|on|by|or|but|so|it|there|here|when|where|while)$/i;

const clean = (value) => {
  const out = String(value).trim().replace(/[.,;:]+$/, "").trim();
  return out && !VALUE_JUNK.test(out) ? out : null;
};

/**
 * Pull a labelled value. Two passes, strict then loose, because workers say
 * "invoice number is INV-2291" and "invoice number INV-2291" in the same shift
 * and neither should be missed. The strict pass guards against the label word
 * of the next field being consumed as this field's value, and a single word is
 * rejected when it sits next to another label word.
 */
function labelled(text, labels, pattern, { maxWords = 6 } = {}) {
  for (const strict of [true, false]) {
    for (const label of labels) {
      const bridge = strict ? `\\s*(?:is|are|of|:|=|,)?\\s*` : `\\s*(?:${FILLER})?\\s*`;
      const re = new RegExp(`\\b${label}\\b${bridge}(${pattern})`, "gi");
      let match;
      while ((match = re.exec(text)) !== null) {
        const candidate = clean(match[1]);
        if (!candidate) continue;
        const words = candidate.split(/\s+/);
        if (words.length > maxWords) continue;
        if (ADJACENT_LABEL.test(words[0]) && words.length === 1) continue;
        return candidate;
      }
    }
  }
  return null;
}

/** Words that end a free-text value, so it does not swallow the next field. */
const STOP_WORDS = /\b(?:is|are|was|were|and|with|the|a|an|it|them|that|which|who|but|so|then|severity|sev|priority|need|needs|reinspect|next|due|dated|total|qty|quantity|sku|bin|because|after|before|when|while|where|please)\b/i;

/** Free-text values (location, action, description) start at a label and end
 *  at the first word that belongs to the next field. */
function freeText(text, labels, { maxWords = 8 } = {}) {
  const raw = labelled(text, labels, "[A-Za-z0-9][A-Za-z0-9+ ,.\\-/]{1,80}", { maxWords: 60 });
  if (!raw) return null;
  const trimmed = raw.split(STOP_WORDS)[0].replace(/[,;:.\s]+$/g, "").trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > maxWords) return null;
  return trimmed;
}

/** A count that may be spoken as a word and may come before or after its label. */
function countNear(text, labels) {
  for (const label of labels) {
    const after = text.match(new RegExp(`\\b${label}\\b\\D{0,10}([A-Za-z]+|\\d{1,6})`, "i"));
    if (after) {
      const value = wordsToNumber(after[1]);
      if (value !== null) return value;
    }
    const before = text.match(new RegExp(`([A-Za-z]+|\\d{1,6})\\s+\\b${label}\\b`, "i"));
    if (before) {
      const value = wordsToNumber(before[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

export function parseNarration(rawText) {
  const text = ` ${String(rawText || "").replace(/\s+/g, " ").trim()} `;
  const found = {};
  const source = {};
  const confidenceByField = {};

  const set = (key, value, from = "audio", confidence = 0.9) => {
    if (value === null || value === undefined || value === "") return;
    found[key] = value;
    source[key] = from;
    confidenceByField[key] = confidence;
  };
  const has = (re) => re.test(text);

  // -- invoice -------------------------------------------------------
  if (has(/\b(invoice|bill|receipt|vendor|supplier|purchase order)\b/i)) {
    set("vendor", freeText(text, ["vendor", "supplier", "from", "seller", "company"], { maxWords: 6 }), "audio", 0.8);
    set("invoiceNumber", labelled(text,
      ["invoice number", "invoice no", "invoice", "bill number", "ref", "reference"],
      "[A-Z]{0,4}[-/]?\\d[\\d\\-/]{1,15}"), "audio", 0.92);
    set("poNumber", labelled(text, ["purchase order", "po number", "po"], "[A-Z]{0,4}[-/]?\\d[\\d\\-/]{1,15}"));
    set("invoiceDate", normaliseDate(labelled(text, ["invoice date", "dated", "date"], DATE)));
    set("dueDate", normaliseDate(labelled(text, ["due date", "payable by", "payment due"], DATE)));
    set("subtotal", normaliseMoney(labelled(text, ["subtotal", "sub total", "net"], AMOUNT)));
    set("tax", normaliseMoney(labelled(text, ["tax", "vat", "gst"], AMOUNT)));
    set("total", normaliseMoney(labelled(text, ["total due", "grand total", "amount due", "total"], AMOUNT)), "audio", 0.94);
    set("lineItemCount", countNear(text, ["line items", "line item", "items", "lines"]));
  }

  const currencyHit = text.match(/\b(USD|EUR|GBP|INR|AUD|CAD)\b/i);
  if (currencyHit) set("currency", currencyHit[1].toUpperCase(), "audio", 0.85);
  else if (has(/\bdollars?\b|\busd\b/i)) set("currency", "USD");
  else if (has(/\beuros?\b|\beur\b/i)) set("currency", "EUR");
  else if (has(/\bpounds?\b|\bgbp\b|\bsterling\b/i)) set("currency", "GBP");
  else if (has(/\brupees?\b|\binr\b/i)) set("currency", "INR");

  // -- inspection ----------------------------------------------------
  set("assetId", labelled(text,
    ["asset id", "asset", "unit id", "unit", "pole", "meter", "pump", "valve", "tower", "bridge"],
    "(?:[A-Za-z]{0,6}[-/])?\\d[\\dA-Za-z\\-/]{0,15}"));
  const defectWords = ["corrosion", "rust", "crack", "cracked", "leak", "leaking", "deformation",
    "bent", "blockage", "blocked", "electrical", "exposed wiring"];
  for (const word of defectWords) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) {
      const canonical = {
        rust: "corrosion", cracked: "crack", leaking: "leak", bent: "deformation",
        blocked: "blockage", "exposed wiring": "electrical",
      }[word] || word;
      set("defectClass", canonical, "audio", 0.88);
      break;
    }
  }
  set("severity", labelled(text,
    ["severity", "sev", "priority", "graded", "rated", "classed"],
    "[A-Za-z]+", { maxWords: 1 })?.toLowerCase());
  if (!("severity" in found)) {
    if (has(/\bcritical\b/i)) set("severity", "critical", "audio", 0.8);
    else if (has(/\bhigh\b|\bsevere\b|\burgent\b/i)) set("severity", "high", "audio", 0.8);
    else if (has(/\bmedium\b|\bmoderate\b/i)) set("severity", "medium", "audio", 0.8);
    else if (has(/\blow\b|\bminor\b/i)) set("severity", "low", "audio", 0.8);
  }
  // Chainage is spoken as one phrase ("chainage 12+300") and means nothing
  // without its prefix, so it is matched whole before the general case.
  const chainage = text.match(/\b(chainage\s+\d{1,5}\s*\+\s*\d{1,3})\b/i);
  if (chainage) set("location", chainage[1].replace(/\s+/g, " ").replace(/\s*\+\s*/, "+"), "audio", 0.9);
  else set("location", freeText(text, ["location", "near", "beside", "outside", "at"], { maxWords: 6 }));
  set("immediateAction", freeText(text,
    ["immediate action", "action", "need to", "needs", "recommend", "required"], { maxWords: 8 }));
  set("nextInspectionDays", wordsToNumber(labelled(text,
    ["reinspect in", "next inspection in", "review in", "check again in"],
    "\\d{1,4}\\s*(?:days?|weeks?)")));

  // -- inventory -----------------------------------------------------
  set("sku", labelled(text, ["sku", "part number", "part", "item number", "code"],
    "[A-Z]{0,5}[-/]?\\d[\\dA-Z\\-/]{0,17}"), "audio", 0.92);
  set("quantity", wordsToNumber(labelled(text,
    ["quantity", "qty", "count", "there are", "we have", "stock of"],
    "\\d{1,6}")));
  set("description", freeText(text, ["description", "consists of", "which are"], { maxWords: 6 }), "audio", 0.6);
  set("bin", labelled(text, ["bin", "bay", "aisle", "shelf", "rack"],
    "(?:[A-Za-z]{0,4}[-/])?\\d[\\dA-Za-z\\-/]{0,12}"));
  const unitHit = text.match(/\b(each|box(?:es)?|pallet|pallets|kg|kilos?|litres?|liters?|metres?|meters?)\b/i);
  if (unitHit) {
    const raw = unitHit[1].toLowerCase();
    const canonical = { boxes: "box", pallets: "pallet", kilos: "kg", kilo: "kg",
      litres: "litre", liters: "litre", litre: "litre", metres: "metre", meters: "metre", meter: "metre" }[raw] || raw;
    set("unit", canonical, "audio", 0.8);
  }
  const conditionHit = text.match(/\b(sealed|opened|damaged|expired)\b/i);
  if (conditionHit) set("condition", conditionHit[1].toLowerCase(), "audio", 0.85);

  // A quantity written as a counted phrase: "240 boxes", "twelve pallets".
  if (!("quantity" in found)) {
    const q = text.match(new RegExp(`\\b(${WORD}|\\d{1,6})\\s+(?:units|items|pieces|pallets|boxes|each)\\b`, "i"));
    const value = q ? wordsToNumber(q[1]) : null;
    if (value !== null) set("quantity", value, "audio", 0.7);
  }

  return { fields: found, sources: source, confidenceByField, text: text.trim() };
}

/* ------------------------------------------------------------------ */
/* Visual statistics (runs on a downscaled frame, cheap enough for a   */
/* mid-range phone and good enough to corroborate what was said)       */
/* ------------------------------------------------------------------ */

export function analyseFrame(bitmap, maxSide = 96) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const luma = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const v = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    luma[p] = v; sum += v;
  }
  const mean = sum / luma.length;
  let variance = 0, edges = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      variance += (luma[p] - mean) ** 2;
      if (x > 0 && y > 0) {
        const dx = Math.abs(luma[p] - luma[p - 1]);
        const dy = Math.abs(luma[p] - luma[p - w]);
        if (dx + dy > 48) edges += 1;
      }
    }
  }
  const contrast = Math.sqrt(variance / luma.length) / 128;
  const edgeDensity = edges / luma.length;
  const aspect = bitmap.width / bitmap.height;

  // A document held flat fills the frame with high-contrast straight edges and
  // a portrait/landscape ratio near A4; a scene shot is lower contrast with a
  // busier, more isotropic edge field.
  const docLikelihood = Math.max(0, Math.min(1,
    0.55 * Math.min(1, edgeDensity * 3.2) + 0.45 * (1 - Math.min(1, Math.abs(aspect - 1.414) / 1.0))));

  return {
    width: bitmap.width,
    height: bitmap.height,
    meanLuma: Math.round(mean),
    contrast: Math.round(contrast * 1000) / 1000,
    edgeDensity: Math.round(edgeDensity * 10000) / 10000,
    docLikelihood: Math.round(docLikelihood * 1000) / 1000,
    underexposed: mean < 42,
    blurry: edgeDensity < 0.012,
  };
}

/* ------------------------------------------------------------------ */
/* Fusion                                                              */
/* ------------------------------------------------------------------ */

export function fuse(profile, parsed, vision, engineId) {
  const fields = {};
  const fieldSources = {};
  const confidences = [];
  const reviewReasons = [];

  for (const spec of profile.fields) {
    let value = parsed.fields[spec.key] ?? null;
    let from = parsed.sources[spec.key] ?? (value === null ? null : "audio");
    let confidence = value === null ? 0 : (parsed.confidenceByField[spec.key] ?? 0.7);

    if (value !== null && spec.type === "number") value = normaliseMoney(value);
    if (value !== null && spec.type === "integer") {
      const n = Number.parseInt(String(value).replace(/[^0-9-]/g, ""), 10);
      value = Number.isFinite(n) ? n : null;
    }
    if (value !== null && spec.type === "date") value = normaliseDate(value);
    if (value !== null && spec.type === "enum" && !spec.values.includes(value)) {
      // Keep the spoken word but distrust it; a human decides in the queue.
      confidence = Math.min(confidence, 0.5);
      reviewReasons.push(`${spec.key}="${value}" is outside ${spec.values.join("/")}`);
    }

    // Correlation: an invoice read with the camera framed on a document is
    // materially more likely to be right than the same read of a blurry shot.
    if (value !== null && spec.key !== "location") {
      if (vision.docLikelihood > 0.7 && profile === PROFILES.invoice) confidence = Math.min(1, confidence + 0.05);
      if (vision.underexposed || vision.blurry) confidence = Math.max(0.3, confidence - 0.15);
    }
    if (value !== null && from === "audio" && vision.docLikelihood > 0.7) from = "fused";

    fields[spec.key] = value;
    if (value !== null) {
      fieldSources[spec.key] = from;
      confidences.push(confidence);
    }
  }

  const missingRequired = profile.fields
    .filter((f) => f.required && (fields[f.key] === null || fields[f.key] === undefined))
    .map((f) => f.key);

  const mean = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const confidence = Math.round(Math.max(0, Math.min(1, mean - 0.06 * missingRequired.length)) * 100) / 100;

  return {
    fields,
    fieldSources,
    confidence,
    missingRequired,
    reviewReasons,
    needsReview: confidence < REVIEW_THRESHOLD || missingRequired.length > 0 || reviewReasons.length > 0,
    engine: engineId,
  };
}

/* ------------------------------------------------------------------ */
/* Engine implementations                                              */
/* ------------------------------------------------------------------ */

export class RulesEngine {
  constructor() {
    this.id = "fieldlens-rules:v1";
    this.label = "On-device rules extractor";
    this.detail = "Deterministic, no weights, always available";
    this.ready = true;
  }

  async load() { this.ready = true; return true; }

  async unload() { /* nothing to release */ }

  async extract({ profile, narration, frameStats }) {
    const parsed = parseNarration(narration);
    const result = fuse(profile, parsed, frameStats, this.id);
    return {
      ...result,
      narrative: buildNarrative(profile, parsed, result, frameStats),
    };
  }
}

/**
 * Phi-3-Vision on the NPU.
 *
 * The app does not ship the weights: they are compiled per device by the host
 * runtime and exposed as window.__FIELDLENS_VLM__. Loading fails loudly when
 * that runtime is absent, which is the honest outcome - a caller must then use
 * RulesEngine rather than receive invented values.
 */
export class Phi3VisionNpuEngine {
  constructor(options = {}) {
    this.id = options.id || "phi-3-vision-int4:npu";
    this.label = "Phi-3-Vision (NPU/WebGPU)";
    this.detail = "Local VLM, structured JSON decoding";
    this.ready = false;
    this.reason = null;
    this.promptCache = new Map();
  }

  async load() {
    const runtime = globalThis.__FIELDLENS_VLM__;
    if (!runtime) {
      this.ready = false;
      this.reason = "no host VLM runtime bridged into this webview";
      return false;
    }
    const backend = detectAccelerator();
    if (!backend) {
      this.ready = false;
      this.reason = "neither WebNN nor WebGPU is available on this device";
      return false;
    }
    try {
      await runtime.load({ model: "phi-3-vision", quantization: "int4", backend });
      this.ready = true;
      this.reason = null;
      return true;
    } catch (err) {
      this.ready = false;
      this.reason = `runtime load failed: ${err?.message || err}`;
      return false;
    }
  }

  async unload() {
    const runtime = globalThis.__FIELDLENS_VLM__;
    if (runtime && this.ready) await runtime.unload().catch(() => {});
    this.ready = false;
  }

  buildPrompt(profile) {
    if (this.promptCache.has(profile.label)) return this.promptCache.get(profile.label);
    const fieldLines = profile.fields.map((f) => {
      const type = f.type === "enum" ? `one of ${f.values.join("|")}` : f.type;
      return `  "${f.key}": ${type}${f.required ? "  // required" : ""}`;
    });
    const prompt = [
      "You are an offline field-data extraction model.",
      "You will receive one photograph and the operator's spoken narration at the moment of capture.",
      "The narration is the operator's intent: prefer it for identity fields (numbers, ids, codes).",
      "Use the photograph to confirm and to supply fields the operator did not say aloud.",
      `Return JSON only, matching this schema exactly for profile "${profile.key}":`,
      "{",
      fieldLines.join(",\n"),
      "}",
      "Use null for anything you cannot read. Do not guess. Do not explain.",
    ].join("\n");
    this.promptCache.set(profile.label, prompt);
    return prompt;
  }

  async extract({ profile, narration, imageBitmap, frameStats }) {
    if (!this.ready) throw new Error(`engine not loaded: ${this.reason || "unknown reason"}`);
    const runtime = globalThis.__FIELDLENS_VLM__;
    const raw = await runtime.invoke({
      prompt: this.buildPrompt(profile),
      images: imageBitmap ? [imageBitmap] : [],
      audioTranscript: narration,
      maxTokens: 384,
      temperature: 0,
      constrainedDecoding: true,
    });
    const json = typeof raw === "string" ? extractJsonObject(raw) : raw;
    const parsed = { fields: {}, sources: {}, confidenceByField: {}, text: narration };
    for (const spec of profile.fields) {
      const value = json?.[spec.key];
      if (value === null || value === undefined || value === "") continue;
      parsed.fields[spec.key] = value;
      parsed.sources[spec.key] = runtime.reportsAudioContribution?.(spec.key) ? "fused" : "visual";
      parsed.confidenceByField[spec.key] = 0.85;
    }
    const result = fuse(profile, parsed, frameStats, this.id);
    return { ...result, narrative: buildNarrative(profile, parsed, result, frameStats) };
  }
}

function detectAccelerator() {
  if (globalThis.navigator?.ml) return "webnn";
  if (globalThis.navigator?.gpu) return "webgpu";
  return null;
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function buildNarrative(profile, parsed, result, frameStats) {
  const label = profile.label.toLowerCase();
  const captured = Object.entries(result.fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
  const missing = result.missingRequired.length ? ` Unread required fields: ${result.missingRequired.join(", ")}.` : "";
  const shot = frameStats.blurry
    ? " The frame is soft; re-shoot if a required field stays empty."
    : frameStats.underexposed
      ? " The frame is dark; re-shoot if a required field stays empty."
      : "";
  const said = parsed.text ? `Operator said: "${parsed.text}".` : "No narration was captured.";
  return `Offline ${label} capture. ${said} Extracted ${captured || "nothing"}.${missing}${shot}`;
}

export class EngineRegistry {
  constructor() {
    this.engines = [new Phi3VisionNpuEngine(), new RulesEngine()];
    this.active = null;
    this.attempts = [];
  }

  async activate() {
    this.attempts = [];
    for (const engine of this.engines) {
      const ok = await engine.load();
      this.attempts.push({ id: engine.id, label: engine.label, loaded: ok, reason: engine.reason || null });
      if (ok) {
        this.active = engine;
        return engine;
      }
    }
    throw new Error("no extraction engine could be loaded");
  }

  status() {
    return {
      active: this.active ? { id: this.active.id, label: this.active.label, detail: this.active.detail } : null,
      attempts: this.attempts,
    };
  }
}
