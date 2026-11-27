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
