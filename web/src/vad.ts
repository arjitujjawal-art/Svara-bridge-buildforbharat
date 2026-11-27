import * as ort from "onnxruntime-web/wasm";
import { Silero } from "@ricky0123/vad-web/dist/models/silero";
import model from "@ricky0123/vad-web/dist/silero_vad_v5.onnx?url";
import wasm from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import runtime from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import { FRAME_SAMPLES } from "./endpoint";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  wasm: new URL(wasm, location.origin),
  mjs: new URL(runtime, location.origin),
};

export function loadVad() {
  return Silero.new(ort, async () => {
    const response = await fetch(model);
    if (!response.ok) throw new Error("The local speech detector could not load.");
    return response.arrayBuffer();
  });
}

export async function measure(samples: Float32Array, signal?: AbortSignal) {
  const detector = await loadVad();
  const probabilities: number[] = [];
  try {
    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
      signal?.throwIfAborted();
      const frame = new Float32Array(FRAME_SAMPLES);
      frame.set(samples.subarray(offset, offset + FRAME_SAMPLES));
      const result = await detector.process(frame);
      probabilities.push(result.isSpeech);
    }
    return probabilities;
  } finally {
    await detector.release();
  }
}
