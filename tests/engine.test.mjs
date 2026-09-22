/**
 * Extraction engine tests.
 *
 * These run in plain Node against the same module the phone loads, because the
 * thing worth testing is not "does the VLM work" but "when the VLM is absent,
 * does the app still produce a record a human can verify, and does it refuse to
 * invent values it cannot see".
 *
 *   node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PROFILES,
  REVIEW_THRESHOLD,
  normaliseMoney,
  normaliseDate,
  parseNarration,
  fuse,
  RulesEngine,
  Phi3VisionNpuEngine,
} from "../fieldlens/static/engine.js";

const NEUTRAL_FRAME = { blurry: false, underexposed: false, docLikelihood: 0.5 };

test("money normalisation handles separators, symbols and trailing noise", () => {
  assert.equal(normaliseMoney("$1,240.50"), 1240.5);
  assert.equal(normaliseMoney("₹ 18,400"), 18400);
  assert.equal(normaliseMoney("94.5 dollars"), 94.5);
  assert.equal(normaliseMoney("n/a"), null);
});

test("date normalisation accepts the formats a worker actually says", () => {
  assert.equal(normaliseDate("2026-03-04"), "2026-03-04");
  assert.equal(normaliseDate("04/03/2026"), "2026-03-04");
  assert.equal(normaliseDate("4 March 2026"), "2026-03-04");
  assert.equal(normaliseDate("March 4th"), `${new Date().getFullYear()}-03-04`);
  assert.equal(normaliseDate("sometime next week"), null);
});

test("invoice narration yields the labelled fields", () => {
  const parsed = parseNarration(
    "This is invoice number INV-2291 from Acme Industrial, dated 04/03/2026, " +
    "subtotal 1200, tax 216, total 1416 dollars, purchase order PO-88, six line items",
  );
  assert.equal(parsed.fields.invoiceNumber, "INV-2291");
  assert.equal(parsed.fields.invoiceDate, "2026-03-04");
  assert.equal(parsed.fields.subtotal, 1200);
  assert.equal(parsed.fields.tax, 216);
  assert.equal(parsed.fields.total, 1416);
  assert.equal(parsed.fields.poNumber, "PO-88");
  assert.equal(parsed.fields.lineItemCount, 6);
  assert.equal(parsed.fields.currency, "USD");
});

test("inspection narration maps colloquial defect words onto the enum", () => {
  const parsed = parseNarration(
    "Pump P-114 at chainage 12+300 is leaking badly, severity high, " +
    "need to replace the gasket today, reinspect in 30 days",
  );
  assert.equal(parsed.fields.assetId, "P-114");
  assert.equal(parsed.fields.defectClass, "leak");
  assert.equal(parsed.fields.severity, "high");
  assert.ok(parsed.fields.location.includes("chainage 12+300"));
  assert.equal(parsed.fields.nextInspectionDays, 30);
});

test("inventory narration reads ids, counts and units", () => {
  const parsed = parseNarration("SKU AB-4471, quantity 240, in bin C-12, these are sealed boxes");
  assert.equal(parsed.fields.sku, "AB-4471");
  assert.equal(parsed.fields.quantity, 240);
  assert.equal(parsed.fields.bin, "C-12");
  assert.equal(parsed.fields.unit, "box");
  assert.equal(parsed.fields.condition, "sealed");
});

test("a required field that was never said is reported missing, not invented", () => {
  const parsed = parseNarration("there is a crack on the north wall");
  const result = fuse(PROFILES.inspection, parsed, NEUTRAL_FRAME, "test");
  assert.equal(result.fields.assetId, null);
  assert.equal(result.fields.defectClass, "crack");
  assert.deepEqual(result.missingRequired, ["assetId", "severity"]);
  assert.equal(result.needsReview, true);
  assert.equal(result.fieldSources.assetId, undefined);
});

test("a complete reading clears review, an incomplete one keeps it", () => {
  const profile = { ...PROFILES.inventory, key: "inventory" };
  const complete = fuse(profile, parseNarration("SKU X-1, quantity 12 sealed boxes in bin A1"), NEUTRAL_FRAME, "test");
  assert.deepEqual(complete.missingRequired, []);
  assert.equal(complete.needsReview, false);
  assert.ok(complete.confidence >= REVIEW_THRESHOLD);

  const partial = fuse(profile, parseNarration("SKU X-1, in bin A1"), NEUTRAL_FRAME, "test");
  assert.deepEqual(partial.missingRequired, ["quantity"]);
  assert.equal(partial.needsReview, true);
});

test("a value outside the declared enum is kept but flagged for a human", () => {
  const parsed = parseNarration("asset P-1 has severe corrosion, severity catastrophic");
  const result = fuse(PROFILES.inspection, parsed, NEUTRAL_FRAME, "test");
  assert.equal(result.fields.severity, "catastrophic");
  assert.equal(result.fields.assetId, "P-1");
  assert.equal(result.needsReview, true, "an out-of-enum value must not pass review");
  assert.ok(result.reviewReasons.some((r) => r.includes("severity")), "the reason must name the field");
});

test("correcting an out-of-enum value clears the review flag", () => {
  const profile = PROFILES.inspection;
  const parsed = parseNarration("asset P-114 is leaking, severity catastrophic");
  const flagged = fuse(profile, parsed, NEUTRAL_FRAME, "test");
  assert.equal(flagged.needsReview, true);

  // What the queue does when the worker picks the right severity from the enum.
  const corrected = {
    ...parsed,
    fields: { ...parsed.fields, severity: "high" },
    confidenceByField: { ...parsed.confidenceByField, severity: 0.9 },
  };
  const cleared = fuse(profile, corrected, NEUTRAL_FRAME, "test");
  assert.equal(cleared.fields.severity, "high");
  assert.deepEqual(cleared.reviewReasons, []);
  assert.equal(cleared.needsReview, false);
  assert.ok(cleared.confidence >= REVIEW_THRESHOLD);
});

test("a dark or blurry frame lowers confidence rather than silently passing", () => {
  const profile = { ...PROFILES.inventory, key: "inventory" };
  const parsed = parseNarration("SKU X-1, quantity 12, in bin A1");
  const clean = fuse(profile, parsed, NEUTRAL_FRAME, "test");
  const murky = fuse(profile, parsed, { blurry: true, underexposed: true, docLikelihood: 0.2 }, "test");
  assert.ok(murky.confidence < clean.confidence);
});

test("the rules engine labels its own output so trust is traceable", async () => {
  const engine = new RulesEngine();
  await engine.load();
  const result = await engine.extract({
    profile: { ...PROFILES.inventory, key: "inventory" },
    narration: "SKU X-1, quantity 12 in bin A1",
    frameStats: NEUTRAL_FRAME,
  });
  assert.equal(result.engine, "fieldlens-rules:v1");
  assert.match(result.narrative, /Operator said/);
});

test("the NPU engine refuses to load without a host runtime instead of faking output", async () => {
  const engine = new Phi3VisionNpuEngine();
  const loaded = await engine.load();
  assert.equal(loaded, false);
  assert.match(engine.reason, /runtime|WebGPU|WebNN|host/);
  await assert.rejects(
    () => engine.extract({ profile: PROFILES.invoice, narration: "x", frameStats: NEUTRAL_FRAME }),
    /engine not loaded/,
  );
});

test("every declared field is typed, and required fields are a subset", () => {
  for (const [key, profile] of Object.entries(PROFILES)) {
    assert.ok(profile.fields.length > 0, `${key} declares no fields`);
    for (const field of profile.fields) {
      assert.ok(["text", "number", "integer", "date", "enum"].includes(field.type), `${key}.${field.key} bad type`);
      if (field.type === "enum") assert.ok(field.values?.length, `${key}.${field.key} enum without values`);
    }
    assert.ok(profile.fields.some((f) => f.required), `${key} has no required field`);
  }
});
