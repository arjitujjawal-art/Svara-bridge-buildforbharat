# SvaraBridge agent instructions

## Required for every AI agent

1. Read this file before starting any task in this repository. Check `git status --short --branch` and `git log -3 --oneline` to identify local work and changes since the last handoff.
2. Read the relevant implementation and tests before editing. Use the [README](README.md) for setup, test commands, and outstanding architecture work.
3. When you change the repository, update **Latest handoff** in the same change. Record what changed, where, which checks ran, and any open issue. Refresh **Built so far** when capabilities change. Keep both sections short and use Git for older history.

## Built so far

- `api/` runs the FastAPI relay. The server owns room events and appointment state. A patient accepts a specific offer and the clinic confirms that same offer.
- `web/src/` serves the patient, clinic desk, and test lab. The patient can record Hindi/Hinglish speech, calibrate pause timing locally, clarify an hour, use switch input, and privately review the exact revision before sending it.
- Docker Compose packages whisper.cpp recognition and eSpeak NG playback. Check `/api/health` for current availability. Fresh-speech accuracy and physical Android behavior still need validation.

## Latest handoff

- Added this mandatory read-first and update-on-change rule. Checked the summary against the README and Git history.
- Latest product change (`3f63b69`): `web/src/review.ts` binds interpretation to the offer present at capture. Ambiguous hours prompt a choice. Unsupported wording stays editable. Caption, read-back, and delivery use the same reviewed decision.
- That product change passed eight frontend tests, five backend tests, and three Chromium workflows. The review test injected transcripts. The cloud model download was blocked during that run.
