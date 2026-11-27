import assert from "node:assert/strict";
import { test } from "node:test";
import { calibratedWait, FRAME_MS, internalPauses } from "../src/endpoint.ts";
import { readTiming, saveTiming } from "../src/timing.ts";

test("measure only gaps between sustained speech and ignore isolated noise spikes", () => {
  const silence = frames => Array(frames).fill(0.1);
  const speech = frames => Array(frames).fill(0.9);
  const trace = [
    ...silence(100), ...speech(3), ...silence(4), ...speech(4),
    ...silence(20), ...speech(1), ...silence(25), ...speech(3), ...silence(200),
  ];
  assert.deepEqual(internalPauses(trace), [46 * FRAME_MS]);
  assert.deepEqual(internalPauses(silence(100)), []);
  assert.deepEqual(internalPauses([...speech(4), ...silence(50)]), []);
});

test("estimate median cadence across three phrases with repeatable evidence", () => {
  assert.equal(calibratedWait([[1800], [2000], []]), 3420);
  assert.equal(calibratedWait([[200, 1800], [3000], []]), 3240);
  assert.equal(calibratedWait([[256], [256], [256]]), 2500);
  assert.equal(calibratedWait([[4000], [3000], [3500]]), 4000);
  assert.equal(calibratedWait([[1800, 1900], [], []]), null);
  assert.equal(calibratedWait([[1800], [2000]]), null);
});

test("restore supported local preferences and tolerate stale or unavailable storage", () => {
  let raw = null;
  const storage = {
    getItem: () => raw,
    setItem: (_, value) => { raw = value; },
    removeItem: () => { raw = null; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    for (const corrupt of ["malformed", '{"version":2,"waitMs":2700}', '{"version":1,"waitMs":80}']) {
      raw = corrupt;
      assert.equal(readTiming(), 3000);
    }
    for (const wait of [0, 3240, 4000, 3000]) {
      assert.ok(saveTiming(wait));
      assert.equal(readTiming(), wait);
    }
    assert.equal(raw, null);
    Object.defineProperty(globalThis, "localStorage", { get() { throw Error("unavailable"); } });
    assert.equal(readTiming(), 3000);
    assert.equal(saveTiming(3250), false);
  } finally {
    delete globalThis.localStorage;
  }
});
