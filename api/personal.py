import asyncio
import hashlib
import os
import re
import secrets
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4
from xml.etree import ElementTree

import httpx
import numpy as np
from fastapi import Header, Request, Response

from .protocol import Payload, Text
from .rooms import Room, RoomError
from .voice_engine import VoiceEngine, reference_pcm

CONSENT = "own-voice-v1"
MAX_REFERENCE = 15 * 24000 * 2 + 4096
CLIP_TTL = 1800


class RenderRequest(Payload):
    text: Text
    language: Literal["hi", "en"] = "hi"


class Attach(Payload):
    render_id: UUID
    event_id: UUID
    turn_id: UUID
    revision: int


@dataclass
class Clip:
    owner: str
    text: str
    audio: bytes
    expires: float
    approved: bool = False
    call: str | None = None


class PersonalVoice:
    def __init__(self):
        self.models = Path(os.getenv("SVARA_VOICE_MODELS", "/voice/models"))
        self.profiles = Path(os.getenv("SVARA_VOICE_PROFILES", "/voice/profiles"))
        self.engine = None
        self.busy = False
        self.clips: dict[UUID, Clip] = {}
        self.grants: dict[str, tuple[UUID, float]] = {}

    def installed(self):
        return (self.models / "tokenizer.json").is_file() and all(
            (self.models / "onnx" / (name + ext)).is_file()
            for name in ("speech_encoder", "embed_tokens", "language_model_q4", "conditional_decoder")
            for ext in (".onnx", ".onnx_data")
        )

    def owner(self, auth):
        scheme, _, token = auth.partition(" ")
        if scheme.lower() == "bearer" and re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            key = hashlib.sha256(token.encode()).hexdigest()
            if self.path(key).is_file():
                return key
        raise RoomError("voice_missing", "This voice profile is unavailable on this server.", 401)

    def path(self, key):
        return self.profiles / (key + ".npz")

    async def compute(self, operation):
        if self.busy:
            raise RoomError("voice_busy", "The voice model is busy. Retry shortly.", 429)
        if not self.installed():
            raise RoomError("model_missing", "Personal voice weights are still unavailable.", 503)
        self.busy = True

        def run():
            if self.engine is None:
                self.engine = VoiceEngine(self.models)
            return operation(self.engine)

        def done(task):
            self.busy = False
            if not task.cancelled():
                task.exception()

        job = asyncio.create_task(asyncio.to_thread(run))
        job.add_done_callback(done)
        return await asyncio.shield(job)

    def prune(self):
        now = time.monotonic()
        for key, clip in list(self.clips.items()):
            if clip.expires <= now:
                del self.clips[key]
        for key, (clip_id, expiry) in list(self.grants.items()):
            if expiry <= now or clip_id not in self.clips:
                del self.grants[key]

    def get(self, render_id, owner=None):
        self.prune()
        clip = self.clips.get(render_id)
        if not clip or (owner is not None and clip.owner != owner) or not self.path(clip.owner).exists():
            raise RoomError("clip_missing", "This audio has expired or its voice was deleted.", 404)
        return clip

    def save(self, data):
        self.profiles.mkdir(parents=True, exist_ok=True)
        if sum(1 for _ in self.profiles.glob("*.npz")) >= 64:
            raise RoomError("profiles_full", "This installation has reached its voice profile limit.", 503)
        token = secrets.token_urlsafe(32)
        target = self.path(hashlib.sha256(token.encode()).hexdigest())
        with tempfile.NamedTemporaryFile(dir=self.profiles, delete=False) as tmp:
            temporary = Path(tmp.name)
            try:
                np.savez(tmp, **data, consent=CONSENT, enrolled=int(time.time()))
                tmp.flush()
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        return token


def phone_settings(owner):
    if not owner or owner != os.getenv("SVARA_PHONE_PROFILE"):
        return None
    sid, token, source, target, origin = (os.getenv("SVARA_" + key, "") for key in
                                         ("TWILIO_ACCOUNT", "TWILIO_TOKEN", "PHONE_FROM", "PHONE_TO", "PUBLIC_ORIGIN"))
    parsed = urlsplit(origin)
    if (re.fullmatch(r"AC[0-9a-fA-F]{32}", sid) and token and parsed.scheme == "https"
            and parsed.hostname and not parsed.username and not parsed.query and not parsed.fragment
            and parsed.path in ("", "/") and all(re.fullmatch(r"\+[1-9]\d{6,14}", n) for n in (source, target))):
        return sid, token, source, target, origin.rstrip("/")
    return None


def install_voice_routes(app, authenticate, rooms):
    voice = PersonalVoice()

    @app.get("/api/voice/status")
    async def status(authorization: str = Header(default="")):
        owner = voice.owner(authorization) if authorization else None
        phone = phone_settings(owner)
        return {"profile_id": owner, "model": "installed" if voice.installed() else "unavailable",
                "phone_destination": ("…" + phone[3][-4:]) if phone else None}

    @app.post("/api/voice/profile", status_code=201)
    async def enroll(request: Request, x_voice_consent: str = Header(default="")):
        if x_voice_consent != CONSENT:
            raise RoomError("consent_required", "Confirm that this is your own voice and you consent.", 422)
        if request.headers.get("content-type", "").split(";")[0] != "audio/wav":
            raise RoomError("reference_format", "Upload a PCM WAV recording.", 415)
        buf = bytearray()
        try:
            async with asyncio.timeout(15):
                async for block in request.stream():
                    if len(buf) + len(block) > MAX_REFERENCE:
                        raise RoomError("reference_large", "Choose a clip up to 15 seconds.", 413)
                    buf.extend(block)
        except TimeoutError as exc:
            raise RoomError("reference_timeout", "Upload interrupted. Please retry.", 408) from exc
        pcm = reference_pcm(bytes(buf))
        features = await voice.compute(lambda engine: engine.enroll(pcm))
        return {"token": voice.save(features)}

    @app.get("/api/voice/profile")
    async def profile(authorization: str = Header(default="")):
        voice.owner(authorization)
        return {"consent_version": CONSENT}

    @app.delete("/api/voice/profile", status_code=204)
    async def forget(authorization: str = Header(default="")):
        owner = voice.owner(authorization)
        voice.path(owner).unlink()
        for key, clip in list(voice.clips.items()):
            if clip.owner == owner:
                del voice.clips[key]
        voice.prune()
        for room in rooms.rooms.values():
            if room.pending_voice and room.pending_voice[0] not in voice.clips:
                room.pending_voice = None
        return Response(status_code=204)

    @app.post("/api/voice/renders")
    async def render(body: RenderRequest, authorization: str = Header(default="")):
        owner = voice.owner(authorization)
        voice.prune()
        if sum(len(item.audio) for item in voice.clips.values()) >= 96 * 1024 * 1024:
            raise RoomError("voice_storage_busy", "Temporary audio storage is full. Retry later.", 503)
        with np.load(voice.path(owner), allow_pickle=False) as stored:
            features = {key: stored[key] for key in ("condition", "prompt", "speaker", "features")}
        wav = await voice.compute(lambda engine: engine.render(body.text, body.language, features))
        voice.owner(authorization)
        key = uuid4()
        voice.clips[key] = Clip(owner, body.text, wav, time.monotonic() + CLIP_TTL)
        return {"render_id": key}

    @app.get("/api/voice/renders/{key}")
    async def preview(key: UUID, authorization: str = Header(default="")):
        return Response(voice.get(key, voice.owner(authorization)).audio, media_type="audio/wav")

    @app.post("/api/voice/renders/{key}/approve")
    async def approve(key: UUID, authorization: str = Header(default="")):
        voice.get(key, voice.owner(authorization)).approved = True
        return {"approved": True}

    @app.post("/api/voice/attach")
    async def attach(body: Attach, room_id: UUID, authorization: str = Header(default=""),
                     x_voice_token: str = Header(default="")):
        room, role = authenticate(room_id, authorization)
        Room.require_role(role, "patient")
        clip = voice.get(body.render_id, voice.owner("Bearer " + x_voice_token))
        room.pending_voice = (body.render_id, body.event_id, body.turn_id, body.revision, clip.text, clip.expires)
        return {"attached": True}

    @app.get("/api/voice/messages/{message_id}")
    async def message(message_id: UUID, room_id: UUID, authorization: str = Header(default="")):
        room, _ = authenticate(room_id, authorization)
        entry = room.messages.get(str(message_id))
        decision = entry["event"].get("decision", {}) if entry else {}
        if not decision.get("voice_render"):
            raise RoomError("message_missing", "No approved personal audio for this message.", 404)
        return Response(voice.get(UUID(decision["voice_render"])).audio, media_type="audio/wav")

    @app.post("/api/voice/renders/{key}/call")
    async def call(key: UUID, authorization: str = Header(default="")):
        clip = voice.get(key, voice.owner(authorization))
        config = phone_settings(clip.owner)
        if not config:
            raise RoomError("phone_unavailable", "Phone calling is not configured.", 503)
        if not clip.approved:
            raise RoomError("approval_required", "Approve this audio before calling.")
        if clip.call:
            return {"status": clip.call}
        sid, token, source, target, origin = config
        grant = secrets.token_urlsafe(32)
        voice.grants[grant] = (key, time.monotonic() + 600)
        response = ElementTree.Element("Response")
        ElementTree.SubElement(response, "Say").text = "A personal AI voice message follows."
        ElementTree.SubElement(response, "Play").text = f"{origin}/api/voice/phone-audio/{grant}"
        clip.call = "submitting"
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                result = await client.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json",
                                           auth=(sid, token), data={"To": target, "From": source,
                                           "Twiml": ElementTree.tostring(response, encoding="unicode")})
            if result.status_code == 201:
                clip.call = "queued"
            elif 400 <= result.status_code < 500:
                voice.grants.pop(grant, None)
                clip.call = None
                raise RoomError("call_rejected", "The phone provider rejected the call. Check account settings.", 502)
            else:
                clip.call = "unknown"
        except (httpx.HTTPError, asyncio.CancelledError):
            clip.call = "unknown"
        return {"status": clip.call}

    @app.get("/api/voice/phone-audio/{grant}")
    async def phone_audio(grant: str):
        voice.prune()
        entry = voice.grants.get(grant)
        if not entry:
            raise RoomError("link_expired", "This playback link is unavailable.", 404)
        return Response(voice.get(entry[0]).audio, media_type="audio/wav")

    return voice
