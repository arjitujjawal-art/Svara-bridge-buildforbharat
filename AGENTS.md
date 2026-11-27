# SvaraBridge project context for AI agents

## Required workflow

Read this file before starting **any** repository task. Run `git status --short --branch` and `git log -3 --oneline` to see local work and commits since the handoff. Read the implementation and tests for the path you will touch. The [README](README.md) contains the operator walkthrough and installation commands.

For every repository change, update **Latest handoff** in the same change. Record the behavior changed, the relevant paths, the checks actually run, and any remaining blocker. When a capability ships, update the corresponding architecture, evidence, and remaining-work sections. Add a history entry for significant milestones. Keep the accumulated product context useful to someone who has never seen the chat.

## End goal and acceptance scenario

SvaraBridge is a Build for Bharat hackathon prototype for an adult whose speech an unfamiliar listener may struggle to understand and whose hands make typing corrections difficult. The patient uses Android Chrome and speaks Hindi or Hinglish. A receptionist on a separate laptop can listen and respond. A caregiver may assist with first launch, microphone permission, audio setup, and pairing. **Success means the patient completes a correct exchange independently after setup.**

The reference exchange starts when the receptionist offers Friday at five. The patient says “Paanch baje nahi. Monday ko chaar baje milega?” The app must preserve the refusal, privately clarify morning or afternoon, and let the patient hear or inspect the complete counteroffer. Only the patient can authorize delivery. The receptionist hears it on their device and can offer another slot. Confirmation requires the patient to accept that exact offer and the desk to confirm it. Repeat with a judge-selected day or time to prove the exchange works beyond the example.

The scope is a turn-based in-app conversation about fictional clinic logistics. The PRD prioritizes live patient input, private correction, single-switch access, two-way playback, keyless CPU operation, and a repeatable judge walkthrough. Carrier calls, WhatsApp, external appointment systems, additional languages, and clinical deployment are future integrations.

## How the project reached this point

| Milestone | What it contributed |
|---|---|
| Empty repository and PRD v1.0, 27 Nov 2026 | Onboarding initially found an unborn checkout. The PRD established patient control, the clinic scenario, acceptance tests, and a Docker-first distribution plan. |
| `7f980fc` | Introduced FastAPI speech and room APIs, role credentials, in-memory offer transitions, revision checks, replay, and backend tests. |
| `f69ac74` | Connected the React patient, desk, and lab views to the relay. Added Compose, local speech adapters, microphone capture, Silero endpointing, switch controls, a simulated desk, and Chromium tests. |
| `00c041f` | Added optional three-phrase pause calibration, device-local timing preferences, reset, and a lab comparison using the saved wait. |
| `3f63b69` | Fixed the case where any “nahi” could become an appointment refusal. Added offer-aware interpretation, hour clarification, verbatim fallback, and one reviewed decision for caption, speech, and delivery. |
| `08bb33c` and this documentation update | Established mandatory agent handoffs and expanded the file into a standalone account of the product, implementation, evidence, and release goals. |

## The current call, end to end

1. **Pair the participants.** At `/patient`, **Call my clinic** creates a room and a single-use desk invite. Opening it in a separate browser profile or device pairs `/desk`. The desk sends a date and time in India time. **Try a sample call** instead connects a clearly labeled simulated desk through the same protocol.
2. **Capture the patient’s turn.** An AudioWorklet captures microphone samples. Browser-side Silero VAD measures speech in 512-sample frames at 16 kHz. The endpoint policy retains roughly 300 ms of pre-roll and defaults to a three-second wait. The patient can finish manually. A turn is capped at 30 seconds and submitted as 16 kHz, mono, signed 16-bit PCM WAV. Hang-up and backgrounding disarm capture.
3. **Adjust timing when needed.** Before a call, **Find my pause time** measures three phrases locally. It uses internal pauses of at least 256 ms bounded by sustained speech. With usable gaps in at least two phrases, it suggests 1.8 times the median gap, clamped to 2.5–4 seconds. Applying it stores the wait and a format version on the device. Cancel, manual override, and reset are supported.
4. **Interpret and repair privately.** The recognizer returns raw text for a turn ID and revision. Review binds that turn to the offer open at capture. A limited Hindi/Hinglish grammar checks the refused weekday, hour, or period against that offer. “Monday chaar ya saat baje” retains Monday and presents hour choices followed by AM/PM. Weekdays resolve against the demo week beginning 30 Nov 2026 in `Asia/Kolkata`. Conditional speech such as “haan, lekin…” and unsupported language remain editable in the patient’s own words.
5. **Approve and deliver.** The caption, private Hindi read-back, and outgoing decision derive from one revision. Editing invalidates the previous review. A replaced offer blocks the old structured decision. The patient explicitly approves. The desk receives the committed message and can play it. **Delivered** records peer receipt. **Played** records completed playback.
6. **Complete or decline the appointment.** A refusal or counteroffer closes the old offer for acceptance. The desk can issue a fresh offer. Patient acceptance leaves confirmation pending until the desk confirms the same offer ID. The patient can also send a general message or end the call.
7. **Exercise the accessible and judge paths.** Space selects a highlighted action while switch scanning is enabled. Scan speed and pause controls are available. **Use sample recording** sends a synthetic Hindi WAV through recognition. **Use example transcript** seeds a labeled draft in solo mode. The lab at `/lab` compares the same recording and Silero frame trace at 800 ms, 3,000 ms, and a distinct saved automatic wait when present.

## Architecture and ownership

| Boundary | Where to work | Contract to preserve |
|---|---|---|
| Patient, desk and lab UI | [main.tsx](web/src/main.tsx), [Comparison.tsx](web/src/Comparison.tsx) | The two roles have independent controls. Drafts belong to the patient browser. Sound requires browser permission or user interaction. Reconnect disarms approval and restores committed history. |
| Capture, detection and calibration | [audio.ts](web/src/audio.ts), [capture.worklet.js](web/src/capture.worklet.js), [vad.ts](web/src/vad.ts), [endpoint.ts](web/src/endpoint.ts), [Calibration.tsx](web/src/Calibration.tsx), [timing.ts](web/src/timing.ts) | Release microphone tracks after capture. Keep prompts and listening mutually exclusive. Preserve manual finish when detection cannot keep up. Calibration audio stays in the browser. |
| Meaning and consent | [clinic.ts](web/src/clinic.ts), [review.ts](web/src/review.ts) | Keep original wording available. Generate the outgoing text and requested slot together. A stale recognition response, edit, ambiguous field, or replaced offer must never silently commit a decision. |
| Transport and room state | [relay.ts](web/src/relay.ts), [protocol.py](api/protocol.py), [rooms.py](api/rooms.py), [main.py](api/main.py) | One FastAPI worker owns authoritative appointment state. Role checks, serialized transitions, event IDs, and sequence numbers support idempotent retries and ordered recovery. The server can replay a retained range or return a snapshot. Historical messages require explicit playback. |
| Speech services and distribution | [speech.py](api/speech.py), [Compose](docker-compose.yml), [ASR image](infra/Dockerfile.asr), [model startup](infra/start-asr.sh), [fixture generation](infra/make_sample.py) | The app serves the built React/TypeScript assets, HTTP APIs, WebSocket relay, and Hindi eSpeak NG synthesis. A separate internal whisper.cpp CPU service transcribes Hindi without translation. The app validates uploaded audio before forwarding it to the recognizer. The clinic receives approved text for playback. |

**Service entry points.** Create and join rooms via `POST /api/rooms` and `POST /api/rooms/join`. Use `POST /api/turns/transcribe` for patient audio, `POST /api/speech` for private or peer playback, and `WS /api/relay` for committed events and receipts. `GET /api/health` reports app, recognition, synthesis, and sample readiness separately. `GET /api/sample.wav` returns the synthetic fixture.

**Operational assumptions.** Patient and desk credentials are distinct. Invites expire after ten minutes. Rooms expire after 30 minutes of inactivity and disappear on process restart. The app bounds room count, event history, command count, audio size, and concurrent speech work. One recognition job can run at a time. Preserve these ownership and concurrency assumptions if changing the worker topology.

## Running and verifying a change

Start a normal local checkout with `docker compose up --build`. The app defaults to host port 8080. Android microphone testing requires a trusted HTTPS origin with WebSocket forwarding. In the managed cloud checkout the app has run on port 3000 using `SVARA_PORT=3000 docker compose -f docker-compose.yml -f infra/compose.proxy.yml up --build -d`. The proxy override supplies CA trust. First ASR startup downloads and verifies the 142 MiB multilingual base model into a named volume. Later starts reuse the verified file. Check actual feature readiness after every restart.

| Check | What it demonstrates |
|---|---|
| `python -m unittest discover -s tests -v` | Backend contract coverage for role isolation, invitation reuse, offer replacement, two-party confirmation, retry/replay, audio validation, and cancellation of a recognition request. |
| `node --experimental-strip-types --test web/tests/*.test.mjs` | Deterministic tests for endpoint timing, calibration, local settings, interpretation, ambiguous hours, and obsolete offers. |
| `npm --prefix web ci` then `npm --prefix web run build` | Locked frontend installation, TypeScript checks, and production asset bundling. CI also validates `docker compose config --quiet`. |
| `python tests/browser_exchange.py` and `python tests/browser_review.py` | Separate Chromium contexts exercise pairing, playback, private review, refusal, counteroffer, and confirmation. The review test injects transcripts at the ASR boundary. |
| `python tests/browser_capture.py` and `python tests/browser_calibration.py` | A synthetic microphone exercises the production AudioWorklet, automatic endpoint, upload, track release, and private three-phrase calibration. Capture can pass when the upload receives the expected ASR-unavailable response. |

Use Python 3.12 and Node 22 as in [CI](.github/workflows/checks.yml). Install the packages in [requirements.txt](requirements.txt) and, for browser runs, [requirements-browser.txt](requirements-browser.txt) plus Playwright Chromium. Browser tests use `SVARA_TEST_ORIGIN` for a different port and `CHROMIUM_PATH` for a system browser. Run the checks that exercise the affected behavior and report the input used.

## Evidence and unfinished work

The synthetic fixture contains a 1.5-second internal pause. A recorded browser run cut the same audio at 3.07 s with the fixed wait and 6.03 s with the longer wait. A three-phrase synthetic microphone run produced a 2.707 s suggestion and verified apply, reload, and reset. These measurements establish software behavior on those inputs. Fresh Hindi/Hinglish recognition, natural-voice intelligibility, and independent use on physical Android remain open.

| Remaining milestone | Exit evidence |
|---|---|
| Make CPU recognition reproducible | Obtain the checksum-verified weights, observe ASR ready, and transcribe fresh Hindi/Hinglish turns with paid keys unset. Compare base and small on target hardware for refusals, names, days, times, and inference latency. |
| Finish speech-based repair and approval | A spoken “shaam” fills the pending period on the same draft while preserving the day and refusal. Late responses are discarded. The patient can explicitly approve by voice or switch. Playback cannot trigger approval. Retain the current clarification buttons as a working path. |
| Add personal vocabulary | An explicit patient choice saves a pronunciation mapping scoped to doctor selection. Show the raw wording, support reversal and deletion, and verify unrelated phrases retain their meaning. |
| Validate the actual user journey | Use trusted HTTPS on an Android phone, a separate laptop, and an unfamiliar receptionist. Exercise mic denial, audio unlock, playback interruption, reconnect, switch-only use, TalkBack, 320 CSS-pixel width, and 200% zoom. Have the desk choose a new slot on the second run. |
| Measure outcomes | The PRD proposes three consenting speakers with eight held-out utterances each. Measure truncation, polarity and slot errors, clarifications, and independent correct exchanges. Separate waiting time, inference, and delivery. Engineering targets include zero unapproved turns or incorrectly confirmed refusals on the finite suite, warm median review within 3 s of endpoint closure, and median audible delivery within 2 s of approval. Report actual denominators, devices, and failures. |
| Package the hackathon submission | Verify the signed-in Round 2 brief, judging criteria, deadline and time zone. The PRD records a single submission by 30 Nov at 11:59 pm, public source, root Compose, keyless startup, roughly 300+ original lines, a public or unlisted video of at most three minutes, and a selectable-text PDF deck. Verify a clean-machine run and signed-out links. Public hosting is optional. Document authentic Wispr Flow use during development if available. |

The longer-term PRD pilot proposes 30 consenting patients across two rehabilitation clinics, targeting 24 independent correct exchanges and six more successes than usual setup. Partnerships, recruitment, and pilot outcomes are future work. Use fictional appointment details in development and obtain separate permission for evaluation recordings and public release of any clip.

## Latest handoff — 27 November 2026

- **Repository change.** Expanded the root agent instructions using PRD v1.0, the implementation, test sources, and the complete commit history. The latest application feature is the private interpretation and review change at `3f63b69`.
- **Checked for this handoff.** Five backend tests and eight frontend tests passed. Compose configuration validated. The running cloud app reported app, TTS, and sample ready, with ASR unavailable. Its ASR container logged HTTP 403 fetching the model. Browser evidence above comes from earlier feature runs.
- **Where to resume.** Check live model access and health before starting recognition work. An environment draft previously proposed model-host access and startup instructions. Applied network access, publication, and successful model loading each require verification. After model loading, exercise a fresh refusal and counteroffer through both devices.
