import assert from "node:assert/strict";
import { test } from "node:test";
import { candidate, reviewDecision, timeOf } from "../src/review.ts";
import { SAMPLE_TEXT } from "../src/clinic.ts";

const offer = { offer_id: "a", status: "open", slot: { date: "2026-12-04", time: "17:00:00", timezone: "Asia/Kolkata" } };

test("preserve an unresolved hour and require the same open offer at approval", () => {
  for (const raw of [SAMPLE_TEXT, "Paanch baje nahi. Monday ko chaar baje milega?"]) {
    const draft = candidate(raw, offer);
    assert.equal(draft.intent, "counter");
    assert.equal(draft.date, "2026-11-30");
    assert.equal(draft.hour, 4);
    assert.equal(draft.time, "");
    assert.equal(reviewDecision(draft, offer), null);
    const fixed = { ...draft, time: timeOf(4, "pm"), revision: 2 };
    const result = reviewDecision(fixed, offer);
    assert.equal(result.revision, 2);
    assert.equal(result.requested_slot.time, "16:00");
    assert.match(result.approved_text, /नहीं/);
    assert.match(result.approved_text, /सोमवार/);
    assert.equal(reviewDecision(fixed, { ...offer, offer_id: "b" }), null);
    assert.equal(reviewDecision(fixed, { ...offer, status: "declined" }), null);
  }
});

test("match spoken refusals against the actual offered weekday, hour and period", () => {
  for (const raw of ["नहीं", "nahin", "Friday ko shaam paanch baje nahi"]) {
    assert.equal(reviewDecision(candidate(raw, offer), offer).intent, "decline");
  }
  for (const raw of ["Tuesday nahi", "subah paanch baje nahi", "saat baje nahi", "nahi?"]) {
    assert.equal(reviewDecision(candidate(raw, offer), offer).approved_text, raw);
    assert.equal(candidate(raw, offer).intent, "message");
  }
  const nextWeek = { ...offer, slot: { ...offer.slot, date: "2026-12-11" } };
  assert.equal(candidate("Friday nahi", nextWeek).intent, "message");
  const halfPast = { ...offer, slot: { ...offer.slot, time: "17:30:00" } };
  assert.equal(candidate("paanch baje nahi", halfPast).intent, "message");
});

test("preserve unsupported, conditional and multiply negated speech verbatim", () => {
  for (const raw of [
    "Dard nahi hai", "Haan, lekin Monday ko chaar baje", "Nahi nahi", "nahi doctor Sharma",
    "Nahi. Monday chaar baje agar doctor Sharma hain", "Monday ko subah aur shaam chaar baje",
    "शुक्रवार नहीं। सोमवार चार बजे नहीं।", "हाँ", "paanch baje nahi, Monday 4:30 pm",
  ]) {
    const result = reviewDecision(candidate(raw, offer), offer);
    assert.equal(result.intent, "message", raw);
    assert.equal(result.approved_text, raw);
    assert.equal(result.offer_id, undefined);
  }
});

test("keep supported alternatives available and distinguish explicit AM and PM", () => {
  const draft = candidate("नहीं। सोमवार को ४ या ७ बजे मिलेगा?", offer);
  assert.deepEqual(draft.hours, [4, 7]);
  assert.equal(draft.hour, null);
  assert.equal(draft.date, "2026-11-30");
  assert.equal(reviewDecision(draft, offer), null);
  assert.equal(candidate("nahi Monday shaam chaar baje", offer).time, "16:00");
  assert.equal(candidate("nahi Monday ko 12 am", offer).time, "00:00");
  assert.equal(candidate("nahi Monday 12 pm", offer).time, "12:00");
  assert.equal(reviewDecision(candidate(SAMPLE_TEXT), null).approved_text, SAMPLE_TEXT);
});
