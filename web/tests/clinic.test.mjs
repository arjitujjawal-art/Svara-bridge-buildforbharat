import assert from "node:assert/strict";
import { test } from "node:test";
import { findBoundary, FRAME_MS } from "../src/endpoint.ts";

test("a controlled 1.5 second pause differentiates the two endpoints", () => {
  const probabilities = [0, 0, ...Array(20).fill(0.9), ...Array(47).fill(0), ...Array(20).fill(0.9)];
  const fixed = findBoundary(probabilities, 800);
  const longer = findBoundary(probabilities, 3000);
  assert.deepEqual(fixed, { start: 0, end: 22 + Math.ceil(800 / FRAME_MS), reason: "silence" });
  assert.deepEqual(longer, { start: 0, end: probabilities.length, reason: "end of file" });
  assert.equal(findBoundary(Array(180).fill(0.1), 800), null);
});
