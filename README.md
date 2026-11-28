# SvaraBridge

```sh
docker compose up --build
```

Open `/voice` on port 8080 to create a personal voice, or `/patient` to start a Hindi/Hinglish clinic exchange. The patient reviews a draft privately, approves a revision, and then the clinic receives the approved wording. This demo uses fictional appointments and temporary rooms.

## Speak in your own voice

1. Open **My voice** at `/voice`. Choose one to three clear clips of yourself from before your speech changed. The browser uses the beginning of each, up to 15 seconds combined, and needs at least three seconds. Confirm the consent statement and choose **Create my voice**. Only enroll the speaker who gives consent. For a software demonstration use the synthetic WAV from `/api/sample.wav`.
2. Type what you mean, select a phrase using a switch or keyboard, or dictate in Hindi/Hinglish and correct the text. Choose Hindi or English for the generated speech. The recognizer can mishear individual words, including negations and names.
3. Choose **Generate private preview**, listen to the whole recording, and approve it when both the words and the voice sound right. Editing the draft clears its approval. Use **Speak aloud** in person, download the WAV to attach to a message, or use **Share voice message** where the browser supports sharing files.
4. To use the voice with a receptionist, open **Clinic call** in the same browser and pair the desk. The patient reviews a private audio rendering, then approves sending. The desk plays those exact bytes. Switch to the standard voice under **Access preferences** when desired.

Chatterbox runs on the app server's CPU. A shared multilingual model uses speaker features extracted from the reference recording for each person. The app discards the uploaded audio after encoding. It keeps the derived profile in the `voice-profiles` Docker volume until deletion. The profile can generate speech that resembles the speaker. Protect that volume, host backups and the browser's access key. Profiles have no account recovery or application-level encryption. Clearing browser storage loses the key. **Remove profile → Delete my voice profile** removes stored features and revokes hosted clips and phone links. Exported files remain with their recipients.

The first startup downloads about 1.5 GiB of pinned Chatterbox assets to `voice-model`. Each file has a SHA-256 entry in [the model manifest](voice/model.json). `docker compose logs voice-model` shows provisioning progress. `GET /api/voice/status` reports installed weights, and the first enrollment loads the engine. Re-run `docker compose up -d voice-model` after a failed download. One personal-voice inference runs at a time. Hosted clips expire after 30 minutes or on app restart. Use a trusted private installation for enrollment and protect the app and its storage when deploying.

### Optional outgoing phone message

The calling adapter makes one outbound Twilio call to a configured recipient and plays the approved clip after announcing that it is AI-generated. To test on the telephone network, the operator needs a calling-enabled account, a permitted caller ID, a consenting reachable destination, and a public HTTPS endpoint that Twilio can fetch. In a private deployment, route only `/api/voice/phone-audio/` from the public origin and disable request-path logging there because the URL contains a short-lived playback grant.

| Deployment variable | Value |
|---|---|
| `SVARA_TWILIO_ACCOUNT`, `SVARA_TWILIO_TOKEN` | Account SID and authentication token from the provider, injected through the deployment secret store |
| `SVARA_PHONE_FROM`, `SVARA_PHONE_TO` | Approved caller and recipient numbers in international E.164 format |
| `SVARA_PHONE_PROFILE` | The enrolled speaker's **Phone setup identifier** shown in the voice profile panel |
| `SVARA_PUBLIC_ORIGIN` | Public HTTPS origin serving the playback grant |

Recreate the app after configuring these values. The enrolled speaker can then select **Call … and play message** after approval. A queued response means the provider accepted the request. An unknown submission needs an operator check in the provider console before any retry. Live two-way phone conversation, incoming calls, and delivery receipts from external messaging apps remain open.

## Run the exchange

1. Select **Call my clinic** on `/patient`. Open the single-use clinic invite in a separate browser profile or share it with your second device. The invite opens `/desk` and expires after 10 minutes.
2. From the desk, pick a date and local time. On the patient screen, play the offer, speak a reply, or select a structured decision. Read back the private draft and approve it. On the desk, play the delivered patient message.
3. Enter a different appointment from the desk and test again. A patient acceptance is pending until the clinic confirms the same offer.
4. **Try a sample call** pairs a simulated receptionist through the same relay. **Use sample recording** runs recognition. **Use example transcript** explicitly seeds a draft when recognition is unavailable.

`/lab` shows feature readiness and compares the same recording with 800 ms and 3,000 ms endpointing. The shipped fixture is generated by Hindi eSpeak NG with a 1.5-second inserted pause. Each clip comes from the same Silero frame trace. The transcripts appear when the CPU recogniser is available.

For Android microphone capture, serve the same origin over trusted HTTPS and forward WebSocket upgrades with the original Host header. Localhost is suitable for a single laptop. Space selects the currently highlighted button when scanning is enabled. Use manual Finish if speech detection is still warming up.

### Personal pause time

Before a call, choose **Access preferences → Find my pause time**. Record three short phrases and finish each one yourself. Silero measures gaps of at least 256 ms between sustained speech segments. With usable pauses in at least two phrases, the suggested wait is 1.8 times the median internal pause, bounded to 2.5–4 seconds. Choose **Use suggested wait** to apply it to future turns on this browser. You can also select a wait manually, choose manual finish, or reset the preference to three seconds.

Calibration runs on the device. The browser saves only the chosen wait and a format version. The test lab includes the saved automatic wait as a third comparison when it differs from three seconds.

## Local speech services

- The app container hosts static assets, FastAPI, and Hindi eSpeak NG. The internal ASR container builds whisper.cpp v1.7.6 from a commit- and checksum-pinned source archive. Its first startup fetches the 142 MiB multilingual base model to a named volume and checks it against [the hash published upstream](https://github.com/ggml-org/whisper.cpp/blob/v1.7.6/models/README.md). Later starts use the verified local copy.
- First build requires Internet access to Docker Hub, Debian, npm, PyPI, GitHub codeload, and Hugging Face plus its download redirect. If the model download fails, the app and local playback still start, and `/lab` reports ASR unavailable. After connectivity is restored run `docker compose up -d asr`. Use `docker compose logs asr` to diagnose model startup.
- Under a managed HTTPS proxy, run `docker compose -f docker-compose.yml -f infra/compose.proxy.yml up --build` and set `SVARA_NETWORK_CA` to the trusted PEM bundle if it differs from the system default in the override. Verification stays enabled.
- This local build has one app worker, in-memory rooms that expire after 30 minutes of inactivity, and one concurrent ASR job. Restarting the app clears the rooms. Test with fictional logistics and consented recordings. Only approved messages and structured offer/receipt events enter the room journal.

## Private interpretation and review

The patient browser binds each captured turn to the open offer at recording start. A small Hindi/Hinglish grammar consumes the entire refusal and proposed slot. It checks any spoken refusal time or weekday against that offer. For “paanch baje nahi, Monday chaar ya saat baje”, review keeps Monday, offers four and seven, then asks for AM or PM. **Speak the missing time detail** accepts a supported hour or period on the current revision, including “शाम”. An unclear answer leaves the choices visible. The patient can also send the original wording. Unsupported language and conditions open as editable messages and require explicit approval.

Private review derives the caption, speech and outgoing decision from the same draft revision. Edits invalidate prior review. A replaced offer blocks the old decision. The browser keeps the raw transcript private unless the patient explicitly approves that wording for delivery.

## Remaining architecture work

| Capability | Current boundary | Next verification |
|---|---|---|
| Local recognition | One CPU worker can be busy or unavailable. The first start depends on downloading weights. | The verified base model runs in Compose. Measure refusals, critical-field errors and warm latency with consenting Hindi/Hinglish speakers. |
| Personal word correction | The browser remembers pause timing. A correction made in private review applies to one message. | Add opt-in, reversible doctor-name mappings and verify the same word stays untouched outside doctor selection. |
| Spoken clarification | Review accepts a spoken hour or period, buttons, and switch input. | Verify partial speech on physical Android and evaluate hands-free approval. |
| Evaluation | The suite includes fixtures, browser microphones and two-client exchanges. | Score held-out consented recordings on critical fields, independent task completion and end-to-end latency on physical Android. |

## Testing channels

| Channel | Exercise |
|---|---|
| `/voice` | Enroll, review speech privately, speak aloud, export, and delete a personal voice |
| `/patient` and `/desk` | Pair two independent clients, vary dates/times, inspect private review and two-party confirmation |
| `/lab` | Check service status and inspect both excerpts and available transcripts from one recording |
| `GET /api/health` | Verify app, ASR, TTS, and fixture readiness separately |
| Backend contracts | Test role isolation, single-use invites, revisions, offers, idempotency, replay, and audio validation |
| Browser smoke test | Drive separate Chromium contexts through patient review, playback, counteroffer, and clinic confirmation |

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
npm --prefix web ci
npm --prefix web run build
node --experimental-strip-types --test web/tests/*.test.mjs
docker compose config --quiet
```

With Compose running:

```sh
python -m pip install -r requirements-browser.txt
python -m playwright install chromium
python tests/browser_exchange.py
python tests/browser_review.py
python tests/browser_capture.py
python tests/browser_calibration.py
python tests/browser_voice.py
```

Set `CHROMIUM_PATH` to use a system Chromium and `SVARA_TEST_ORIGIN` if the app is on another port. Browser tests use a synthetic fixture and separate browser contexts. They do not replace live Android or native-speaker intelligibility tests.

## Third-party speech components

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.7.6) and [Whisper](https://github.com/openai/whisper) (MIT). The engine license is included in the ASR image under `/usr/local/share/doc/whisper.cpp/LICENSE`.
- [Silero VAD](https://github.com/snakers4/silero-vad) (MIT), [vad-web](https://github.com/ricky0123/vad) (ISC), and [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT). Package versions and integrity hashes are recorded in the npm lockfile.
- [eSpeak NG](https://github.com/espeak-ng/espeak-ng) (GPL-3.0-or-later). Debian’s binary package, notices, and version-specific source information are available from [its Debian package page](https://packages.debian.org/bookworm/espeak-ng).
- Personalized CPU synthesis uses [Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) and the [ONNX export and inference reference](https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX/tree/452d3f434aa592098f1eedac9099f33642ab2da5), distributed under MIT.
