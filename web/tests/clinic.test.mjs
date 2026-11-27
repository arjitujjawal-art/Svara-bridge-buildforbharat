import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret, SAMPLE_TEXT } from "../src/clinic.ts";
import { findBoundary, FRAME_MS } from "../src/endpoint.ts";

test("a controlled 1.5 second pause differentiates the two endpoints", () => {
  const probabilities = [0, 0, ...Array(20).fill(0.9), ...Array(47).fill(0), ...Array(20).fill(0.9)];
  const fixed = findBoundary(probabilities, 800);
  const longer = findBoundary(probabilities, 3000);
  assert.deepEqual(fixed, { start: 0, end: 22 + Math.ceil(800 / FRAME_MS), reason: "silence" });
  assert.deepEqual(longer, { start: 0, end: probabilities.length, reason: "end of file" });
  assert.equal(findBoundary(Array(180).fill(0.1), 800), null);
});

test("negation and requested hour come from the correct clauses", () => {
  const expected = { rejected: true, date: "2026-11-30", hour: 4, period: "" };
  assert.deepEqual(interpret(SAMPLE_TEXT), expected);
  assert.deepEqual(interpret("Paanch baje nahi. Monday ko chaar baje milega?"), expected);
  assert.equal(interpret("Paanch baje nahi. Monday ko chaar ya saat baje?").hour, null);
  assert.equal(interpret("Paanch baje nahi. Monday ko shaam chaar baje?").period, "pm");
  assert.equal(interpret("Monday ko subah aur shaam chaar baje").period, "");
});
