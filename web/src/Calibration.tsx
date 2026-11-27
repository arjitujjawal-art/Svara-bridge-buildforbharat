import { useEffect, useRef, useState } from "react";
import { Recorder } from "./audio";
import { calibratedWait, internalPauses } from "./endpoint";
import { seconds } from "./timing";

const phrases = [
  "आज शाम मुझे क्लिनिक जाना है।",
  "सोमवार को चार बजे आ सकता हूँ।",
  "कृपया समय दोबारा बताइए।",
];

export function Calibration({ onApply, onExit }: { onApply: (wait: number) => void; onExit: () => void }) {
  const [samples, setSamples] = useState<number[][]>([]);
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "measuring">("idle");
  const [notice, setNotice] = useState("");
  const capture = useRef<Recorder | null>(null);
  const task = useRef<AbortController | null>(null);

  function interrupt() {
    task.current?.abort();
    task.current = null;
    capture.current?.stop();
    capture.current = null;
  }

  useEffect(() => {
    function pause() {
      if (task.current) {
        interrupt();
        setNotice("Recording stopped. You can retry this phrase.");
        setPhase("idle");
      }
    }
    const visibility = () => { if (document.hidden) pause(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pause);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pause);
      interrupt();
    };
  }, []);

  async function finish() {
    const job = task.current;
    const recorder = capture.current;
    if (!job || !recorder) return;
    capture.current = null;
    setPhase("measuring");
    try {
      const pcm = await recorder.finishSamples();
      job.signal.throwIfAborted();
      const { measure } = await import("./vad");
      const trace = await measure(pcm, job.signal);
      job.signal.throwIfAborted();
      const pauses = internalPauses(trace);
      setSamples(prior => [...prior, pauses]);
      setNotice(pauses.length ? "Pause measured." : "No internal pause found in that phrase.");
    } catch (error) {
      if (!job.signal.aborted) setNotice(error instanceof Error ? error.message : "Could not measure the phrase.");
    } finally {
      if (task.current === job) {
        task.current = null;
        setPhase("idle");
      }
    }
  }

  async function record() {
    if (task.current) return;
    const job = new AbortController();
    task.current = job;
    setPhase("starting");
    setNotice("");
    try {
      const recorder = await Recorder.start(() => void finish(), 0, setNotice, job.signal);
      if (job.signal.aborted) recorder.stop();
      else {
        capture.current = recorder;
        setPhase("listening");
      }
    } catch (error) {
      if (!job.signal.aborted) {
        task.current = null;
        setNotice(error instanceof Error ? error.message : "Could not open the microphone.");
        setPhase("idle");
      }
    }
  }

  const done = samples.length === phrases.length;
  const wait = calibratedWait(samples);
  return <section aria-label="Pause calibration">
    <h2>Find my pause time</h2>
    <p>Say three short phrases at your own pace. Use the examples or your own words. Audio is measured in this browser and discarded.</p>
    {!done && <>
      <h3>Phrase {samples.length + 1} of 3</h3>
      <p lang="hi">{phrases[samples.length]}</p>
      {phase === "listening"
        ? <button data-scan onClick={() => void finish()}>Finish phrase</button>
        : <button data-scan disabled={phase !== "idle"} onClick={() => void record()}>Record phrase</button>}
    </>}
    <p role="status">{phase === "measuring" ? "Measuring pauses…" : phase === "starting" ? "Opening microphone…" : notice}</p>
    {done && (wait !== null ? <>
      <p>Suggested wait after speech ends: <strong>{seconds(wait)}</strong>.</p>
      <button data-scan onClick={() => onApply(wait)}>Use suggested wait</button>
    </> : <p>More pauses between words are needed to estimate your timing. Try again or keep your current setting.</p>)}
    {samples.length > 0 && phase === "idle" && <button data-scan onClick={() => {
      setSamples(previous => previous.slice(0, -1));
      setNotice("");
    }}>Redo last phrase</button>}
    {done && <button data-scan onClick={() => { setSamples([]); setNotice(""); }}>Start calibration again</button>}
    <button data-scan onClick={() => { interrupt(); onExit(); }}>Cancel calibration</button>
  </section>;
}
