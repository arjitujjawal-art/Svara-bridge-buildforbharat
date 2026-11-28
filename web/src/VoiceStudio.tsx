import { useEffect, useRef, useState } from "react";
import { Recorder, transcribe } from "./audio";
import { prepareReferences, rememberVoice, renderVoice, voiceHeaders, voiceToken } from "./personal";
import { api, ApiError, createRoom, Credentials } from "./relay";
import { useSwitch } from "./useSwitch";

type Lang = "hi" | "en";
type AudioClip = { id: string; url: string; blob: Blob };
export function VoiceStudio() {
  const [token, setToken] = useState(voiceToken);
  const [files, setFiles] = useState<File[]>([]);
  const [consent, setConsent] = useState(false);
  const [text, setText] = useState("");
  const [language, setLanguage] = useState<Lang>("hi");
  const [clip, setClip] = useState<AudioClip | null>(null);
  const [approved, setApproved] = useState(false);
  const [heard, setHeard] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<{model: string; phone_destination: string | null; profile_id: string | null}>();
  const [scan, setScan] = useState(false);
  const [recording, setRecording] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const capture = useRef<Recorder | null>(null);
  const captureJob = useRef<AbortController | null>(null);
  const room = useRef<Credentials | null>(null);
  useSwitch(scan, 2000);
  const locked = !!busy || recording;
  const phrases = language === "hi"
    ? ["कृपया थोड़ा रुकिए।", "मुझे पानी चाहिए।", "मैं कुछ कहना चाहता हूँ।"]
    : ["Please give me a moment.", "I need some water.", "I have something to say."];

  function refresh() {
    void api("/api/voice/status", { headers: token ? voiceHeaders(token) : {} }).then(r => r.json()).then(setStatus).catch(e => setNotice(e.message));
  }
  useEffect(refresh, [token]);
  useEffect(() => {
    const key = voiceToken();
    if (key) void fetch("/api/voice/profile", { headers: voiceHeaders(key) }).then(response => {
      if (response.status === 401 && voiceToken() === key) {
        rememberVoice(""); setToken(""); setNotice("Your previous profile is unavailable. Enroll again to continue.");
      }
    }).catch(() => {});
    function stopCapture() {
      captureJob.current?.abort();
      capture.current?.stop();
      capture.current = null;
      setRecording(false);
    }
    const hide = () => { if (document.hidden) stopCapture(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", stopCapture);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", stopCapture);
      stopCapture();
    };
  }, []);
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url); }, [clip]);

  function invalidate() { setClip(null); setApproved(false); setHeard(false); }
  function edit(value: string) { setText(value); invalidate(); }
  async function work(label: string, action: () => Promise<void>) {
    setBusy(label); setNotice("");
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Please retry."); }
    finally { setBusy(""); }
  }
  async function enroll() {
    if (!consent) return;
    const wav = await prepareReferences(files);
    const response = await api("/api/voice/profile", { method: "POST", body: wav,
      headers: { "Content-Type": "audio/wav", "X-Voice-Consent": "own-voice-v1" } });
    const value = (await response.json()).token as string;
    rememberVoice(value); setToken(value); setConsent(false); setFiles([]);
    setNotice("Your voice profile is ready. Try a short message and listen to it.");
  }
  async function finish() {
    const recorder = capture.current;
    const job = captureJob.current;
    if (!recorder || !job) return;
    const signal = job.signal;
    capture.current = null; setRecording(false);
    await work("Recognising speech…", async () => {
      const audio = await recorder.finish();
      const turn = crypto.randomUUID();
      async function recognise() {
        signal.throwIfAborted();
        room.current ??= await createRoom();
        return transcribe(room.current, turn, 1, audio, signal);
      }
      const result = await recognise().catch(error => {
        if (!(error instanceof ApiError) || error.code !== "room_missing") throw error;
        room.current = null;
        return recognise();
      });
      job.signal.throwIfAborted();
      if (result.turn_id !== turn || result.revision !== 1 || !result.raw_text.trim()) {
        throw new Error("No usable reply. Type, select a phrase, or record again.");
      }
      edit(result.raw_text);
    });
  }
  async function record() {
    const job = new AbortController();
    player.current?.pause();
    captureJob.current = job;
    const recorder = await Recorder.start(() => void finish(), 0, setNotice, job.signal);
    if (job.signal.aborted) { recorder.stop(); return; }
    capture.current = recorder; setRecording(true);
  }
  function file() {
    return new File([clip!.blob], "SvaraBridge-personal-AI-voice.wav", { type: "audio/wav" });
  }
  return <>
    <header><a href="/patient">SvaraBridge</a><span>PERSONAL VOICE</span></header>
    <main><h1>My voice</h1>
      <p role="status">{busy || notice}</p>
      {status?.model === "unavailable" && <p>The personal voice model is unavailable. <button onClick={refresh}>Check again</button></p>}
      {!token ? <section><h2>Create a voice profile</h2>
        <p>Choose one to three clear recordings of yourself from before your speech changed. Trim them to your voice alone. The app takes up to 15 seconds total, divided across the beginnings of your clips.</p>
        <label>Reference recordings<input type="file" accept="audio/*" multiple disabled={locked}
          onChange={e => setFiles(Array.from(e.target.files ?? []))} /></label>
        <label><input type="checkbox" checked={consent} disabled={locked} onChange={e => setConsent(e.target.checked)} />
          This is my voice. I consent to this server processing the recordings and storing a voice profile so I can generate speech.</label>
        <p>The server discards the uploaded recording after processing. This browser holds the access key. You can delete the profile here.</p>
        <button data-scan className="primary" disabled={locked || !consent || files.length < 1 || files.length > 3 || status?.model !== "installed"}
          onClick={() => void work("Learning your voice…", enroll)}>Create my voice</button>
      </section> : <>
      <section><h2>Compose a message</h2>
        <label>Spoken language<select disabled={locked} value={language} onChange={e => {setLanguage(e.target.value as Lang); invalidate();}}>
          <option value="hi">Hindi</option><option value="en">English</option>
        </select></label>
        <label>What would you like to say?<textarea value={text} maxLength={600} disabled={locked} onChange={e => edit(e.target.value)} /></label>
        <div className="actions">{phrases.map(phrase => <button data-scan key={phrase} disabled={locked} onClick={() => edit(phrase)}>{phrase}</button>)}</div>
        {recording ? <button data-scan onClick={() => void finish()}>Finish speaking</button>
          : <button data-scan disabled={locked} onClick={() => void work("Opening microphone…", record)}>Dictate in Hindi or Hinglish</button>}
        <button data-scan className="primary" disabled={locked || !text.trim() || status?.model !== "installed"} onClick={() => void work("Generating your speech…", async () => {
          invalidate();
          const id = await renderVoice(token, text.trim(), language);
          const blob = await (await api(`/api/voice/renders/${id}`, { headers: voiceHeaders(token) })).blob();
          setClip({ id, blob, url: URL.createObjectURL(blob) });
        })}>Generate private preview</button>
      </section>
      {clip && <section><h2>{approved ? "Approved personal audio" : "Review generated speech"}</h2>
        <p>{text}</p><audio key={clip.id} ref={player} controls controlsList="nodownload" src={clip.url} onEnded={() => setHeard(true)} />
        <button data-scan disabled={locked} onClick={() => void player.current?.play().catch(e => setNotice(e.message))}>{approved ? "Speak aloud" : "Play private preview"}</button>
        <p>Listen for the intended words and a voice you recognise.</p>
        {!approved && <button data-scan disabled={locked || !heard} onClick={() => void work("Approving…", async () => {
          await api(`/api/voice/renders/${clip.id}/approve`, { method: "POST", headers: voiceHeaders(token) }); setApproved(true);
        })}>Approve this audio</button>}
        {approved && <div className="actions">
          <a className="button" href={clip.url} download="SvaraBridge-personal-AI-voice.wav">Download voice message</a>
          {navigator.canShare?.({ files: [file()] }) && <button data-scan disabled={locked} onClick={() => void work("Sharing…", async () => {
            await navigator.share({ files: [file()], title: "My AI-generated voice message" });
          })}>Share voice message</button>}
          {status?.phone_destination ? <button data-scan disabled={locked} onClick={() => void work("Requesting call…", async () => {
            const response = await api(`/api/voice/renders/${clip.id}/call`, { method: "POST", headers: voiceHeaders(token) });
            setNotice("Call status: " + (await response.json()).status);
          })}>Call {status.phone_destination} and play message</button> : <p>Phone delivery needs a configured calling account and destination.</p>}
        </div>}
      </section>}
      <section><h2>Voice profile</h2>
        {status?.profile_id && <details><summary>Phone setup identifier</summary><code>{status.profile_id}</code></details>}
        {deleting ? <><p>Delete the stored voice features and invalidate hosted clips? Files already shared may be retained by recipients.</p>
          <button disabled={locked} onClick={() => void work("Deleting…", async () => {
            await api("/api/voice/profile", { method: "DELETE", headers: voiceHeaders(token) });
            rememberVoice(""); setToken(""); invalidate(); setText(""); setDeleting(false); setNotice("Voice profile deleted.");
          })}>Delete my voice profile</button>
          <button disabled={locked} onClick={() => setDeleting(false)}>Keep profile</button></>
          : <button disabled={locked} onClick={() => setDeleting(true)}>Remove profile</button>}
      </section></>}
      <button data-scan aria-pressed={scan} onClick={() => setScan(!scan)}>{scan ? "Pause scanning" : "Start switch scanning"}</button>
      <p><a href="/patient">Clinic call</a></p>
    </main>
  </>;
}
