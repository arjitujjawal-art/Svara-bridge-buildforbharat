import { useEffect, useRef, useState } from "react";
import { transcribe, wav } from "./audio";
import { findBoundary, FRAME_MS, FRAME_SAMPLES } from "./endpoint";
import { api, createRoom, Credentials } from "./relay";

type Run = { label: string; cutoff: number; url: string; transcript: string };

export function Comparison({ asrReady }: { asrReady: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const room = useRef<Credentials | null>(null);
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);

  async function compare(source: Promise<ArrayBuffer>) {
    setBusy(true);
    setRuns([]);
    urls.current.forEach(URL.revokeObjectURL);
    urls.current = [];
    setStatus("Decoding the recording and measuring speech frames…");
    try {
      const decoder = new OfflineAudioContext(1, 16000, 16000);
      const decoded = await decoder.decodeAudioData(await source);
      if (decoded.duration > 30) throw new Error("Choose a recording up to 30 seconds.");
      const samples = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        decoded.getChannelData(channel).forEach((sample, index) => {
          samples[index] += sample / decoded.numberOfChannels;
        });
      }
      const { measure } = await import("./vad");
      const trace = await measure(samples);
      setStatus("Comparing cutoffs on the same Silero frame trace…");

      for (const [label, wait] of [["Fixed 800 ms", 800], ["Longer 3,000 ms", 3000]] as const) {
        const boundary = findBoundary(trace, wait);
        if (!boundary) throw new Error("The detector found no speech in this recording.");
        const clip = wav(samples.subarray(boundary.start * FRAME_SAMPLES, boundary.end * FRAME_SAMPLES));
        const url = URL.createObjectURL(clip);
        urls.current.push(url);
        let transcript = "Recognition unavailable.";
        if (asrReady) {
          try {
            room.current ??= await createRoom();
            const result = await transcribe(room.current, crypto.randomUUID(), 1, clip, new AbortController().signal);
            transcript = result.raw_text || "No words returned.";
          } catch (error) {
            transcript = error instanceof Error ? error.message : "Recognition failed.";
          }
        }
        setRuns(previous => [...previous, {
          label, cutoff: Math.min(decoded.duration, boundary.end * FRAME_MS / 1000), url, transcript,
        }]);
      }
      setStatus("Comparison complete.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Comparison failed.");
    } finally {
      setBusy(false);
    }
  }

  return <section>
    <h2>Compare one recording</h2>
    <p>Both settings use the same speech probabilities and recognition settings. The demo fixture is synthetic Hindi with a 1.5-second internal pause.</p>
    <button disabled={busy} onClick={() => void compare(
      api("/api/sample.wav").then(response => response.arrayBuffer()),
    )}>Compare sample recording</button>
    <label>Or choose an audio file
      <input type="file" accept="audio/*" disabled={busy} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (file.size > 12_000_000) {
          setStatus("Choose an audio file smaller than 12 MB.");
          return;
        }
        void compare(file.arrayBuffer());
      }} />
    </label>
    <p role="status">{status}</p>
    {runs.map(run => <article key={run.label}>
      <h3>{run.label}</h3>
      <p>Cut at {run.cutoff.toFixed(2)} seconds</p>
      <audio controls aria-label={`${run.label} excerpt`} src={run.url} />
      <p>{run.transcript}</p>
    </article>)}
  </section>;
}
