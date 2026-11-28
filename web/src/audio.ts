import { api, Credentials } from "./relay";
import { Boundary, Endpoint, FRAME_SAMPLES } from "./endpoint";

export const MAX_SECONDS = 30;
const TARGET_RATE = 16000;

export class Recorder {
  private boundary: Boundary | null = null;
  private stopped = false;
  private releaseDetector?: () => void;

  private constructor(
    private context: AudioContext,
    private stream: MediaStream,
    private input: MediaStreamAudioSourceNode,
    private processor: AudioWorkletNode,
    private chunks: Float32Array[],
  ) {}

  static async start(
    finish: () => void, waitMs: number, report: (message: string) => void, signal?: AbortSignal,
  ): Promise<Recorder> {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      throw new Error("Microphone capture requires a supported browser on HTTPS or localhost.");
    }
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      context = new AudioContext();
    }
    let stream: MediaStream | undefined;
    try {
      await context.resume();
      signal?.throwIfAborted();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      signal?.throwIfAborted();
      await context.audioWorklet.addModule(new URL("./capture.worklet.js", import.meta.url));
      signal?.throwIfAborted();
      const input = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "svara-capture", { channelCount: 1 });
      const chunks: Float32Array[] = [];
      const silence = context.createGain();
      silence.gain.value = 0;
      processor.connect(silence).connect(context.destination);
      const maxFrames = Math.floor(context.sampleRate * MAX_SECONDS);
      let samples = 0;
      const recorder = new Recorder(context, stream, input, processor, chunks);
      let detect: ((block: Float32Array) => void) | undefined;
      const bufferedFrames: Float32Array[] = [];
      let backlog = 0;
      processor.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (recorder.stopped || samples >= maxFrames) return;
        const block = data.subarray(0, maxFrames - samples);
        chunks.push(block);
        samples += block.length;
        if (detect) detect(block);
        else if (samples <= TARGET_RATE * 5) bufferedFrames.push(block);
        if (samples >= maxFrames) finish();
      };
      if (waitMs > 0 && context.sampleRate === TARGET_RATE) {
        void import("./vad").then(({ loadVad }) => loadVad()).then(async detector => {
          if (recorder.stopped || samples > TARGET_RATE * 5) {
            await detector.release();
            if (!recorder.stopped) report("Speech detection is still warming up. Use Finish recording.");
            return;
          }
          const endpoint = new Endpoint(waitMs);
          let frame = new Float32Array(FRAME_SAMPLES);
          let offset = 0;
          let pending = Promise.resolve();
          let disabled = false;
          recorder.releaseDetector = () => void pending.then(() => detector.release()).catch(() => {});
          detect = block => {
            if (disabled) return;
            for (let start = 0; start < block.length;) {
              const length = Math.min(block.length - start, FRAME_SAMPLES - offset);
              frame.set(block.subarray(start, start + length), offset);
              offset += length;
              start += length;
              if (offset < FRAME_SAMPLES) continue;
              const complete = frame;
              frame = new Float32Array(FRAME_SAMPLES);
              offset = 0;
              backlog++;
              pending = pending.then(async () => {
                backlog--;
                if (recorder.stopped || disabled || recorder.boundary) return;
                const result = await detector.process(complete);
                if (recorder.stopped || disabled) return;
                recorder.boundary = endpoint.push(result.isSpeech);
                if (recorder.boundary) finish();
              }).catch(() => {
                disabled = true;
                if (!recorder.stopped) report("Speech detection failed. Use Finish recording.");
              });
            }
          };
          bufferedFrames.forEach(detect);
          bufferedFrames.length = 0;
          // A slow model can fall back to manual capture while keeping all original samples.
          const enqueue = detect;
          detect = block => {
            if (!disabled && backlog > 180) {
              disabled = true;
              report("Speech detection is behind. Use Finish recording.");
            }
            enqueue(block);
          };
        }).catch(() => {
          if (!recorder.stopped) report("Speech detection is unavailable. Use Finish recording.");
        });
      } else if (waitMs > 0) {
        report("This device is using manual finish for recording.");
      }
      input.connect(processor);
      return recorder;
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      await context.close();
      throw error;
    }
  }

  async finishSamples(): Promise<Float32Array> {
    const rate = this.context.sampleRate;
    this.stop();
    const length = this.chunks.reduce((size, chunk) => size + chunk.length, 0);
    if (!length) throw new Error("No audio captured. Try again.");
    const audio = new OfflineAudioContext(1, Math.max(1, Math.floor(length * TARGET_RATE / rate)), TARGET_RATE);
    const buffer = audio.createBuffer(1, length, rate);
    let offset = 0;
    for (const chunk of this.chunks) {
      buffer.getChannelData(0).set(chunk, offset);
      offset += chunk.length;
    }
    const source = audio.createBufferSource();
    source.buffer = buffer;
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 7200;
    source.connect(filter).connect(audio.destination);
    source.start();
    const rendered = await audio.startRendering();
    const samples = rendered.getChannelData(0);
    return this.boundary
      ? samples.subarray(this.boundary.start * FRAME_SAMPLES, this.boundary.end * FRAME_SAMPLES)
      : samples;
  }

  async finish(): Promise<Blob> {
    return wav(await this.finishSamples());
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.releaseDetector?.();
    this.input.disconnect();
    this.processor.port.close();
    this.processor.disconnect();
    this.stream.getTracks().forEach(track => track.stop());
    if (this.context.state !== "closed") void this.context.close();
  }
}

export function wav(samples: Float32Array, rate = TARGET_RATE) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const label = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  label(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const value = Math.min(1, Math.max(-1, sample));
    view.setInt16(44 + 2 * index, value * (value < 0 ? 32768 : 32767), true);
  });
  return new Blob([bytes], { type: "audio/wav" });
}

export function headers(credentials: Credentials, type: string) {
  return { Authorization: `Bearer ${credentials.token}`, "Content-Type": type };
}

export async function transcribe(credentials: Credentials, turnId: string, revision: number, audio: Blob, signal: AbortSignal) {
  const query = new URLSearchParams({ room_id: credentials.room_id, turn_id: turnId, revision: String(revision) });
  const response = await api(`/api/turns/transcribe?${query}`, {
    method: "POST", headers: headers(credentials, "audio/wav"), body: audio, signal,
  });
  return await response.json() as { turn_id: string; revision: number; raw_text: string; audio_ms: number; processing_ms: number };
}

export class Playback {
  private context: AudioContext | null = null;
  private current: AbortController | null = null;

  stop() {
    this.current?.abort();
    this.current = null;
  }

  speak(credentials: Credentials, text: string) {
    return this.playRequest(`/api/speech?room_id=${credentials.room_id}`, {
      method: "POST", headers: headers(credentials, "application/json"), body: JSON.stringify({ text }),
    });
  }

  async playRequest(path: string, init: RequestInit) {
    this.stop();
    this.context ??= new AudioContext();
    const context = this.context;
    const abort = new AbortController();
    this.current = abort;
    try {
      await context.resume();
      abort.signal.throwIfAborted();
      const response = await api(path, { ...init, signal: abort.signal });
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      abort.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const node = context.createBufferSource();
        const stop = () => {
          node.stop();
          reject(abort.signal.reason);
        };
        node.buffer = buffer;
        node.connect(context.destination);
        node.onended = () => {
          abort.signal.removeEventListener("abort", stop);
          node.disconnect();
          if (!abort.signal.aborted) resolve();
        };
        abort.signal.addEventListener("abort", stop, { once: true });
        node.start();
      });
    } finally {
      if (this.current === abort) this.current = null;
    }
  }

  close() {
    this.stop();
    if (this.context && this.context.state !== "closed") void this.context.close();
    this.context = null;
  }
}
