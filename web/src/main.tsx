import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Playback, Recorder, transcribe } from "./audio";
import { Comparison } from "./Comparison";
import { displaySlot, interpret, REFERENCE_MONDAY, SAMPLE_TEXT, slot, speakSlot } from "./clinic";
import {
  api, createRoom, Credentials, Decision, emptyRoom, History, joinRoom, reduceRoom, Relay, Role, Slot,
} from "./relay";
import "./style.css";

const SAMPLE_SLOT = slot("2026-12-04", "17:00");

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The action failed. Try again.";
}

function stored(key: string): Credentials | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function useRoom(role: Role) {
  const key = `svara:${role}`;
  const [credentials, setCredentials] = useState(() => stored(key));
  const [state, setState] = useState(emptyRoom);
  const [status, setStatus] = useState("Ready to start.");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const relay = useRef<Relay | null>(null);

  function attach(value: Credentials | null) {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    setCredentials(value);
    setReady(false);
    setState(emptyRoom);
  }

  useEffect(() => {
    if (!credentials) return;
    let active = true;
    setStatus("Connecting…");
    const connection = new Relay(
      credentials,
      event => {
        if (!active) return;
        setState(previous => reduceRoom(previous, event));
        if (event.type === "room.ended" || event.type === "room.snapshot" && event.ended) {
          sessionStorage.removeItem(key);
        }
      },
      (connected, message) => {
        if (active) {
          setReady(connected);
          setStatus(message);
        }
      },
    );
    relay.current = connection;
    return () => {
      active = false;
      connection.close();
      relay.current = null;
    };
  }, [credentials, attempt, key]);

  return {
    credentials, state, status, ready, relay, attach,
    reconnect: () => { setReady(false); setAttempt(value => value + 1); },
  };
}

type RoomClient = ReturnType<typeof useRoom>;

function usePeerPlayback(room: RoomClient, role: Role, playback: Playback, setNotice: (message: string) => void) {
  const startedReceipts = useRef(new Set<string>());
  useEffect(() => {
    const connection = room.relay.current;
    if (!room.ready || !connection) {
      startedReceipts.current.clear();
      return;
    }
    for (const message of room.state.history) {
      const id = message.event.message_id;
      if (message.event.sender === role || message.delivered || startedReceipts.current.has(id)) continue;
      startedReceipts.current.add(id);
      void connection.send({ type: "peer.receipt", status: "delivered", message_id: id }).catch(error => {
        startedReceipts.current.delete(id);
        setNotice(errorMessage(error));
      });
    }
  }, [room.ready, room.state.history, room.relay, role, setNotice]);

  return async (message: History) => {
    const connection = room.relay.current;
    if (!room.credentials || !connection || !room.ready) return;
    const id = message.event.message_id;
    const text = message.event.type === "desk.offer"
      ? `क्या ${speakSlot(message.event.appointment.slot)} आपके लिए ठीक है?`
      : message.event.decision.approved_text;
    try {
      if (!message.delivered) await connection.send({ type: "peer.receipt", status: "delivered", message_id: id });
      await playback.speak(room.credentials, text);
      await connection.send({ type: "peer.receipt", status: "played", message_id: id });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice(errorMessage(error));
      await connection.send({ type: "peer.receipt", status: "failed", message_id: id }).catch(() => {});
    }
  };
}

function HistoryList({ items, role, disabled, play }: {
  items: History[]; role: Role; disabled: boolean; play: (item: History) => Promise<void>;
}) {
  return <section aria-labelledby="exchange">
    <h2 id="exchange">Exchange</h2>
    {items.length === 0 && <p>No messages yet.</p>}
    <ol className="history">{items.map(item => <li key={item.event.message_id}>
      <strong>{item.event.sender === "patient" ? "Patient" : "Clinic"}</strong>
      <p>{item.event.type === "desk.offer" ? displaySlot(item.event.appointment.slot) : item.event.decision.approved_text}</p>
      <small>{item.playback === "played" ? "Played" : item.playback === "failed" ? "Playback failed"
        : item.delivered ? "Delivered" : "Waiting for receipt"}</small>
      {item.event.sender !== role && <button type="button" data-scan disabled={disabled}
        onClick={() => void play(item)}>Play {item.event.sender === "patient" ? "patient message" : "clinic offer"}</button>}
    </li>)}</ol>
  </section>;
}

function AppointmentStatus({ room }: { room: RoomClient }) {
  const appointment = room.state.appointment;
  if (!appointment) return null;
  const labels = {
    open: "Offer open", declined: "Offer declined", countered: "Counteroffer sent",
    accepted: "Patient accepted · clinic confirmation pending", confirmed: "Confirmed by clinic",
  };
  return <div className="appointment" role="status">
    <strong>{labels[appointment.status]}</strong>
    <span>{displaySlot(appointment.slot)} · India time</span>
  </div>;
}

function usePlayer(room: RoomClient) {
  const [playback] = useState(() => new Playback());
  useEffect(() => () => playback.close(), [playback]);
  useEffect(() => { if (!room.ready) playback.stop(); }, [room.ready, playback]);
  return playback;
}

function Desk() {
  const room = useRoom("desk");
  const playback = usePlayer(room);
  const [notice, setNotice] = useState("");
  const [date, setDate] = useState(SAMPLE_SLOT.date);
  const [time, setTime] = useState(SAMPLE_SLOT.time);
  const [playing, setPlaying] = useState(false);
  const [pairing, setPairing] = useState(false);
  const play = usePeerPlayback(room, "desk", playback, setNotice);
  const attach = useRef(room.attach);
  attach.current = room.attach;

  useEffect(() => {
    const values = new URLSearchParams(location.hash.slice(1));
    const roomId = values.get("room");
    const invite = values.get("invite");
    if (!roomId || !invite) return;
    history.replaceState(null, "", location.pathname);
    setPairing(true);
    void joinRoom(roomId, invite).then(value => attach.current(value))
      .catch(error => setNotice(errorMessage(error))).finally(() => setPairing(false));
  }, []);

  async function send(command: Parameters<Relay["send"]>[0]) {
    setNotice("");
    try {
      if (!room.relay.current) throw new Error("Connect a room first.");
      await room.relay.current.send(command);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  return <>
    <header><a href="/">SvaraBridge</a><span>CLINIC DESK</span></header>
    <main>
      <h1>Demo clinic desk</h1>
      <p role="status">{pairing ? "Joining patient’s room…" : room.status}</p>
      {notice && <p role="alert">{notice}</p>}
      {!room.credentials && !pairing && <p>Open the private desk invite from the patient screen.</p>}
      {room.credentials && !room.ready && !room.state.ended && <button onClick={room.reconnect}>Reconnect</button>}
      <AppointmentStatus room={room} />
      {room.credentials && <section>
        <h2>Offer an appointment</h2>
        <form onSubmit={event => {
          event.preventDefault();
          void send({ type: "desk.offer", slot: slot(date, time) });
        }}>
          <label>Date <input type="date" value={date} required onChange={event => setDate(event.target.value)} /></label>
          <label>Time in India <input type="time" value={time} required onChange={event => setTime(event.target.value)} /></label>
          <button className="primary" disabled={!room.ready || room.state.appointment?.status === "confirmed"}>Send offer</button>
        </form>
        {room.state.appointment?.status === "accepted" && <button disabled={!room.ready} onClick={() =>
          void send({ type: "desk.confirm", offer_id: room.state.appointment!.offer_id })}>Confirm this appointment</button>}
      </section>}
      <HistoryList role="desk" items={room.state.history} disabled={!room.ready || playing} play={async item => {
        setPlaying(true);
        await play(item);
        setPlaying(false);
      }} />
      {playing && <button onClick={() => playback.stop()}>Stop speech</button>}
      {room.ready && <button onClick={() => void send({ type: "room.end" })}>End call</button>}
    </main>
  </>;
}

type Draft = {
  turn_id: string; eventId: string; revision: number;
  raw: string; text: string; intent: Decision["intent"]; offerId?: string;
  date: string; time: string; hour: number | null; period: "" | "am" | "pm";
};

function candidate(raw: string, currentOffer?: string): Draft {
  const parsed = interpret(raw);
  const time = parsed.hour && parsed.period
    ? `${String(parsed.hour % 12 + (parsed.period === "pm" ? 12 : 0)).padStart(2, "0")}:00` : "";
  const proposed = parsed.date || parsed.hour;
  return {
    turn_id: crypto.randomUUID(), eventId: crypto.randomUUID(), revision: 1, raw, text: raw,
    intent: currentOffer && parsed.rejected ? proposed ? "counter" : "decline" : "message",
    offerId: currentOffer, date: parsed.date, time, hour: parsed.hour, period: parsed.period,
  };
}

function useSwitch(enabled: boolean, speed: number) {
  useEffect(() => {
    if (!enabled) return;
    let active: HTMLButtonElement | null = null;
    function advance() {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("main button[data-scan]:enabled")];
      const index = active ? buttons.indexOf(active) : -1;
      active?.classList.remove("scan");
      active = buttons[(index + 1) % buttons.length] ?? null;
      active?.classList.add("scan");
    }
    function activate(event: KeyboardEvent) {
      if (event.code !== "Space" || (event.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      event.preventDefault();
      if (!event.repeat && active?.isConnected && !active.disabled) active.click();
    }
    advance();
    const timer = window.setInterval(advance, speed);
    window.addEventListener("keydown", activate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", activate);
      active?.classList.remove("scan");
    };
  }, [enabled, speed]);
}

function Patient() {
  const room = useRoom("patient");
  const playback = usePlayer(room);
  const [notice, setNotice] = useState("");
  const playDesk = usePeerPlayback(room, "patient", playback, setNotice);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [readRevision, setReadRevision] = useState<string>();
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "processing" | "playing" | "sending">("idle");
  const [scan, setScan] = useState(false);
  const [speed, setSpeed] = useState(2000);
  const [waitMs, setWaitMs] = useState(3000);
  const [demo, setDemo] = useState(false);
  const [creating, setCreating] = useState(false);
  const recorder = useRef<Recorder | null>(null);
  const work = useRef<AbortController | null>(null);
  const simulatedDesk = useRef<Relay | null>(null);
  const recordingOffer = useRef<string | undefined>(undefined);
  const openOffer = room.state.appointment?.status === "open" ? room.state.appointment.offer_id : undefined;
  useSwitch(scan, speed);

  function stopWork() {
    work.current?.abort();
    work.current = null;
    recorder.current?.stop();
    recorder.current = null;
    playback.stop();
  }

  useEffect(() => {
    if (!room.ready) {
      stopWork();
      setReadRevision(undefined);
      setPhase("idle");
    }
  }, [room.ready]);
  useEffect(() => {
    const pause = () => {
      if (!document.hidden) return;
      stopWork();
      setReadRevision(undefined);
      setPhase("idle");
    };
    document.addEventListener("visibilitychange", pause);
    return () => {
      document.removeEventListener("visibilitychange", pause);
      simulatedDesk.current?.close();
      stopWork();
    };
  }, []);

  useEffect(() => {
    if (draft && room.state.history.some(item => item.event.message_id === draft.eventId)) {
      setDraft(null);
      setReadRevision(undefined);
    }
  }, [draft, room.state.history]);

  async function start(solo: boolean) {
    setCreating(true);
    setNotice("");
    simulatedDesk.current?.close();
    simulatedDesk.current = null;
    setDraft(null);
    setReadRevision(undefined);
    try {
      const credentials = await createRoom();
      if (solo && credentials.invite) {
        const desk = await joinRoom(credentials.room_id, credentials.invite);
        const simulated = new Relay(desk, event => {
          if (event.type === "patient.message") {
            void simulated.send({ type: "peer.receipt", status: "delivered", message_id: event.message_id })
              .catch(error => setNotice(errorMessage(error)));
            if (event.decision.intent === "accept" && event.appointment) {
              void simulated.send({ type: "desk.confirm", offer_id: event.appointment.offer_id })
                .catch(error => setNotice(errorMessage(error)));
            }
          }
        }, ready => {
          if (ready) void simulated.send({ type: "desk.offer", slot: SAMPLE_SLOT })
            .catch(error => setNotice(errorMessage(error)));
        });
        simulatedDesk.current = simulated;
      }
      setDemo(solo);
      room.attach(credentials);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function revise(patch: Partial<Draft>) {
    playback.stop();
    setReadRevision(undefined);
    setDraft(previous => previous && {
      ...previous, ...patch, revision: previous.revision + 1, eventId: crypto.randomUUID(),
    });
  }

  async function recognise(workItem: AbortController, source: Promise<Blob>, offeredId?: string) {
    if (!room.credentials) return;
    setPhase("processing");
    const turnId = crypto.randomUUID();
    try {
      const audio = await source;
      workItem.signal.throwIfAborted();
      const result = await transcribe(room.credentials, turnId, 1, audio, workItem.signal);
      workItem.signal.throwIfAborted();
      if (!result.raw_text) throw new Error("No words were recognised. Try again or use a saved phrase.");
      setDraft({ ...candidate(result.raw_text, offeredId), turn_id: turnId });
      setReadRevision(undefined);
      setNotice(`Local recognition processed ${(result.audio_ms / 1000).toFixed(1)} seconds.`);
    } catch (error) {
      if (!workItem.signal.aborted) setNotice(errorMessage(error));
    } finally {
      if (work.current === workItem) {
        work.current = null;
        setPhase("idle");
      }
    }
  }

  async function beginRecording() {
    setNotice("");
    setReadRevision(undefined);
    const current = new AbortController();
    work.current = current;
    recordingOffer.current = openOffer;
    setPhase("starting");
    try {
      const capture = await Recorder.start(finishRecording, waitMs, setNotice);
      if (current.signal.aborted) {
        capture.stop();
        return;
      }
      recorder.current = capture;
      setPhase("recording");
    } catch (error) {
      if (!current.signal.aborted) {
        setNotice(errorMessage(error));
        work.current = null;
        setPhase("idle");
      }
    }
  }

  function finishRecording() {
    if (!recorder.current || !work.current) return;
    const capture = recorder.current;
    recorder.current = null;
    void recognise(work.current, capture.finish(), recordingOffer.current);
  }

  function prepareOfferDecision(intent: "accept" | "decline") {
    const appointment = room.state.appointment;
    if (!appointment || appointment.status !== "open") return;
    setDraft({
      ...candidate("", appointment.offer_id), intent,
      text: "", date: appointment.slot.date, time: appointment.slot.time,
    });
    setReadRevision(undefined);
  }

  const current = room.state.appointment;
  const stale = draft?.intent !== "message" && draft && (
    !draft.offerId || draft.offerId !== current?.offer_id || current?.status !== "open"
  );
  const requested = draft?.date && draft.time ? slot(draft.date, draft.time) : undefined;
  const currentLabel = current ? speakSlot(current.slot) : "";
  let approved = "";
  if (draft?.intent === "message") approved = draft.text.trim();
  if (draft?.intent === "accept") approved = `हाँ, ${currentLabel} मेरे लिए ठीक है।`;
  if (draft?.intent === "decline") approved = `नहीं, ${currentLabel} मेरे लिए ठीक नहीं है।`;
  if (draft?.intent === "counter" && requested) approved = `नहीं, ${currentLabel} मेरे लिए ठीक नहीं है। क्या ${speakSlot(requested)} मिल सकता है?`;
  const reviewable = !!approved && !stale && phase === "idle" && room.ready;
  const invite = new URL("/desk", location.href);
  if (room.credentials?.invite) invite.hash = new URLSearchParams({
    room: room.credentials.room_id, invite: room.credentials.invite,
  }).toString();

  async function readBack() {
    if (!room.credentials || !draft || !reviewable) return;
    const revision = draft.eventId;
    setPhase("playing");
    setNotice("");
    try {
      await playback.speak(room.credentials, approved);
      setReadRevision(revision);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setNotice(errorMessage(error));
    } finally {
      setPhase("idle");
    }
  }

  async function sendDraft() {
    if (!draft || !reviewable || readRevision !== draft.eventId || !room.relay.current) return;
    setPhase("sending");
    try {
      await room.relay.current.send({
        type: "patient.commit", turn_id: draft.turn_id, revision: draft.revision,
        intent: draft.intent, approved_text: approved,
        offer_id: draft.intent === "message" ? undefined : draft.offerId,
        requested_slot: draft.intent === "counter" ? requested : undefined,
      }, draft.eventId);
      setDraft(null);
      setReadRevision(undefined);
      setNotice("Approved message sent.");
    } catch (error) {
      setReadRevision(undefined);
      setNotice(errorMessage(error));
    } finally {
      setPhase("idle");
    }
  }

  return <>
    <header><a href="/">SvaraBridge</a><span>PATIENT</span></header>
    <main>
      <h1>{room.credentials && !room.state.ended ? "Clinic call" : "Call my clinic"}</h1>
      <p role="status">{room.status}{demo && " · Simulated clinic desk"}</p>
      {notice && <p role="alert">{notice}</p>}
      {(!room.credentials || room.state.ended) && <div className="actions">
        <button data-scan className="primary" disabled={creating} onClick={() => void start(false)}>Call my clinic</button>
        <button data-scan disabled={creating} onClick={() => void start(true)}>Try a sample call</button>
      </div>}
      {room.credentials && !room.ready && !room.state.ended && <div className="actions">
        <button data-scan onClick={room.reconnect}>Reconnect</button>
        <button data-scan disabled={creating} onClick={() => void start(false)}>Start a new call</button>
      </div>}
      {room.ready && !room.state.desk_connected && !demo && <section>
        <h2>Invite the clinic</h2>
        <p>This single-use invite expires in 10 minutes.</p>
        <a className="button" href={invite.href} target="_blank" rel="noreferrer">Open clinic desk</a>
        <button onClick={() => void navigator.clipboard?.writeText(invite.href)
          .then(() => setNotice("Clinic invite copied.")).catch(error => setNotice(errorMessage(error)))}>Copy desk invite</button>
      </section>}
      <AppointmentStatus room={room} />
      {room.ready && room.state.desk_connected && <section>
        <h2>Your turn</h2>
        <div className="actions">
          {phase === "recording" ? <button className="primary" data-scan onClick={finishRecording}>Finish recording</button>
            : <button className="primary" data-scan disabled={phase !== "idle"} onClick={() => void beginRecording()}>Start speaking</button>}
          {phase === "idle" && <button data-scan onClick={() => {
            setReadRevision(undefined);
            setDraft(null);
            const next = new AbortController();
            work.current = next;
            void recognise(next, api("/api/sample.wav", { signal: next.signal }).then(response => response.blob()), openOffer);
          }}>Use sample recording</button>}
          {phase !== "idle" && phase !== "sending" && <button data-scan onClick={() => {
            stopWork(); setPhase("idle");
          }}>Stop</button>}
        </div>
        <p role="status">{phase === "recording" ? "Listening. Take your time."
          : phase === "processing" ? "Recognising locally…" : phase === "starting" ? "Opening microphone…" : ""}</p>
        {current?.status === "open" && <div className="actions">
          <button data-scan disabled={phase !== "idle"} onClick={() => prepareOfferDecision("decline")}>Decline offer</button>
          <button data-scan disabled={phase !== "idle"} onClick={() => prepareOfferDecision("accept")}>Accept for review</button>
          <button data-scan disabled={phase !== "idle"} onClick={() => {
            setDraft({ ...candidate("", current.offer_id), intent: "counter" });
            setReadRevision(undefined);
          }}>Request another time</button>
        </div>}
        <button data-scan disabled={phase !== "idle"} onClick={() => {
          setDraft(candidate("कृपया समय दोबारा बताइए।")); setReadRevision(undefined);
        }}>Saved phrase · repeat the offer</button>
        {demo && <button disabled={phase !== "idle"} onClick={() => {
          setDraft(candidate(SAMPLE_TEXT, current?.status === "open" ? current.offer_id : undefined));
          setReadRevision(undefined);
        }}>Use example transcript (no recognition)</button>}
      </section>}
      {draft && <section className="review" aria-labelledby="private-review">
        <h2 id="private-review">Private review</h2>
        {stale && <p role="alert">The clinic changed the offer. Review the latest offer before replying.</p>}
        {draft.raw && <details><summary>Original transcript</summary><p lang="hi">{draft.raw}</p></details>}
        {draft.intent === "message" && <label>Message
          <textarea value={draft.text} maxLength={600} disabled={phase !== "idle"}
            onChange={event => revise({ text: event.target.value })} /></label>}
        {draft.intent === "counter" && <div>
          {draft.hour && !draft.period && <fieldset>
            <legend>Did you mean {draft.hour} in the morning or later in the day?</legend>
            <div className="actions">{(["am", "pm"] as const).map(period => <button key={period} data-scan
              disabled={phase !== "idle"} onClick={() => revise({
                period, time: `${String(draft.hour! % 12 + (period === "pm" ? 12 : 0)).padStart(2, "0")}:00`,
              })}>{period === "am" ? "Morning" : "Afternoon or evening"}</button>)}
              <button data-scan disabled={phase !== "idle"} onClick={() => {
                setDraft(null); setReadRevision(undefined); void beginRecording();
              }}>Neither · say it again</button></div>
          </fieldset>}
          <label>Requested date <input type="date" value={draft.date} disabled={phase !== "idle"}
            onChange={event => revise({ date: event.target.value })} /></label>
          <label>Requested time in India <input type="time" value={draft.time} disabled={phase !== "idle"}
            onChange={event => revise({ time: event.target.value })} /></label>
        </div>}
        {approved && !stale && <p className="sentence" lang="hi">{approved}</p>}
        {draft.intent === "counter" && requested && <p>{displaySlot(requested)} · India time</p>}
        <div className="actions">
          <button data-scan disabled={!reviewable} onClick={() => void readBack()}>Read back privately</button>
          <button data-scan disabled={!reviewable} onClick={() => setReadRevision(draft.eventId)}>I reviewed the caption</button>
          <button className="primary" data-scan disabled={!reviewable || readRevision !== draft.eventId}
            onClick={() => void sendDraft()}>Approve and send</button>
          <button data-scan disabled={phase === "sending"} onClick={() => {
            stopWork(); setPhase("idle"); setDraft(null); setReadRevision(undefined);
          }}>Cancel draft</button>
        </div>
      </section>}
      <HistoryList role="patient" items={room.state.history} disabled={!room.ready || phase !== "idle"} play={async item => {
        setPhase("playing");
        await playDesk(item);
        setPhase("idle");
      }} />
      <section>
        <h2>Access preferences</h2>
        <label>Pause before finishing a recording <select value={waitMs} disabled={phase !== "idle"}
          onChange={event => setWaitMs(Number(event.target.value))}>
          <option value={2500}>2.5 seconds</option><option value={3000}>3 seconds</option>
          <option value={4000}>4 seconds</option><option value={0}>Manual finish</option>
        </select></label>
        <h3>Switch access</h3>
        <button data-scan aria-pressed={scan} onClick={() => setScan(!scan)}>{scan ? "Pause scanning" : "Start scanning"}</button>
        <label>Scan speed <select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
          <option value={1400}>Fast</option><option value={2000}>Medium</option><option value={3000}>Slow</option>
        </select></label>
        <p>Press Space when the action you want is outlined.</p>
      </section>
      {room.ready && <button data-scan onClick={() => {
        stopWork(); setPhase("idle"); setDraft(null); setReadRevision(undefined);
        void room.relay.current?.send({ type: "room.end" }).catch(() => {});
      }}>End call</button>}
    </main>
  </>;
}

function Lab() {
  const [health, setHealth] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const refresh = () => void api("/api/health").then(response => response.json()).then(setHealth)
    .catch(error => setNotice(errorMessage(error)));
  useEffect(refresh, []);
  return <>
    <header><a href="/">SvaraBridge</a><span>TEST LAB</span></header>
    <main>
      <h1>Test the exchange</h1>
      <p>Use separate browser profiles or devices for a human exchange. Start on the patient screen to get a single-use clinic invite.</p>
      <div className="actions"><a className="button primary" href="/patient">Patient screen</a><a className="button" href="/desk">Clinic desk</a></div>
      <section>
        <h2>Speech services</h2>
        {notice && <p role="alert">{notice}</p>}
        <dl>{Object.entries(health).map(([name, state]) => <div key={name}><dt>{name}</dt><dd>{state}</dd></div>)}</dl>
        <button onClick={refresh}>Refresh status</button>
      </section>
      <Comparison asrReady={health.asr === "ready"} />
      <section>
        <h2>Sample recording</h2>
        <p>Synthetic Hindi fixture. Clinic dates refer to the week beginning {REFERENCE_MONDAY}.</p>
        {health.sample === "ready" && <audio controls src="/api/sample.wav" />}
      </section>
    </main>
  </>;
}

function App() {
  if (location.pathname === "/desk") return <Desk />;
  if (location.pathname === "/lab") return <Lab />;
  return <><nav aria-label="Testing"><a href="/lab">Test lab</a></nav><Patient /></>;
}

createRoot(document.getElementById("root")!).render(<App />);
