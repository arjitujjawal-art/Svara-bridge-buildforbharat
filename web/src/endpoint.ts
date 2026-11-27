export const FRAME_SAMPLES = 512;
export const FRAME_MS = 32;
const PRE_ROLL = Math.ceil(300 / FRAME_MS);
const START_FRAMES = 3;
const SPEECH_THRESHOLD = 0.55;

export type Boundary = { start: number; end: number; reason: "silence" | "end of file" };

export class Endpoint {
  private frame = 0;
  private onset: number | null = null;
  private streak = 0;
  private lastSpeech = 0;

  private readonly waitMs: number;

  constructor(waitMs: number) {
    this.waitMs = waitMs;
  }

  push(probability: number): Boundary | null {
    this.frame++;
    if (probability >= SPEECH_THRESHOLD) {
      this.streak++;
      if (this.onset === null && this.streak >= START_FRAMES) {
        this.onset = Math.max(0, this.frame - this.streak - PRE_ROLL);
      }
      if (this.onset !== null) this.lastSpeech = this.frame;
    } else {
      this.streak = 0;
    }
    if (this.onset !== null && (this.frame - this.lastSpeech) * FRAME_MS >= this.waitMs) {
      return { start: this.onset, end: this.frame, reason: "silence" };
    }
    return null;
  }

  finish(): Boundary | null {
    return this.onset === null ? null : { start: this.onset, end: this.frame, reason: "end of file" };
  }
}

export function findBoundary(probabilities: readonly number[], waitMs: number) {
  const endpoint = new Endpoint(waitMs);
  for (const probability of probabilities) {
    const cutoff = endpoint.push(probability);
    if (cutoff) return cutoff;
  }
  return endpoint.finish();
}

// A pause needs sustained speech on both sides. Keep isolated VAD spikes
// inside the gap, and exclude brief dips between syllables.
export function internalPauses(trace: readonly number[]): number[] {
  const pauses: number[] = [];
  let run = 0;
  let previousSpeechEnd = -1;
  for (let index = 0; index <= trace.length; index++) {
    if (trace[index] >= SPEECH_THRESHOLD) {
      run++;
      continue;
    }
    if (run >= START_FRAMES) {
      const gapMs = (index - run - previousSpeechEnd) * FRAME_MS;
      if (previousSpeechEnd >= 0 && gapMs >= 256) pauses.push(gapMs);
      previousSpeechEnd = index;
    }
    run = 0;
  }
  return pauses;
}

export function calibratedWait(phrases: readonly number[][]): number | null {
  if (phrases.length !== 3 || phrases.filter(pauses => pauses.length > 0).length < 2) return null;
  const pauses = phrases.flat().sort((left, right) => left - right);
  const middle = Math.floor(pauses.length / 2);
  const median = pauses.length % 2 ? pauses[middle] : (pauses[middle - 1] + pauses[middle]) / 2;
  return Math.round(Math.max(2500, Math.min(4000, 1.8 * median)));
}
