import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit
from uuid import uuid4
from xml.etree import ElementTree

import httpx
import numpy as np
from fastapi.testclient import TestClient

from api.main import create_app
from api.personal import CONSENT, PersonalVoice
from test_relay import ORIGIN, event, receive, wav


class PersonalVoiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {"SVARA_VOICE_PROFILES": str(self.folder)}))
        self.enterContext(patch.object(PersonalVoice, "installed", return_value=True))
        engine = self.enterContext(patch("api.personal.VoiceEngine")).return_value
        engine.enroll.return_value = {key: np.array([0.2]) for key in ("condition", "prompt", "speaker", "features")}
        self.audio = wav(24000, b"\x00\x20\x00\xe0" * 36000)
        engine.render.return_value = self.audio
        self.client = self.enterContext(TestClient(create_app()))
        self.headers = {"X-Voice-Consent": CONSENT, "Content-Type": "audio/wav"}

    def enroll(self):
        response = self.client.post("/api/voice/profile", headers=self.headers, content=self.audio)
        self.assertEqual(response.status_code, 201, response.text)
        return {"Authorization": "Bearer " + response.json()["token"]}

    def render(self, owner):
        response = self.client.post("/api/voice/renders", headers=owner, json={"text": "Hello", "language": "en"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["render_id"]

    def test_consent_persistence_privacy_and_revocation(self):
        path = "/api/voice/profile"
        self.assertEqual(self.client.post(path, content=self.audio).json()["code"], "consent_required")
        silence = wav(24000, bytes(3 * 24000 * 2))
        for data in (silence, self.audio[:-10]):
            self.assertEqual(self.client.post(path, content=data, headers=self.headers).status_code, 422)
        owner = self.enroll()
        stored, = self.folder.iterdir()
        with np.load(stored, allow_pickle=False) as features:
            self.assertEqual(set(features.files), {"condition", "prompt", "speaker", "features", "consent", "enrolled"})
        with TestClient(create_app()) as fresh:
            self.assertEqual(fresh.get(path, headers=owner).status_code, 200)
        clip = "/api/voice/renders/" + self.render(owner)
        other = self.enroll()
        self.assertEqual(self.client.get(clip, headers=other).status_code, 404)
        self.assertEqual(self.client.post(clip + "/approve", headers=other).status_code, 404)
        self.assertEqual(self.client.get(clip, headers=owner).content, self.audio)
        self.assertEqual(self.client.delete(path, headers=owner).status_code, 204)
        self.assertFalse(stored.exists())
        self.assertEqual(self.client.get(clip, headers=owner).status_code, 401)
        self.assertEqual(self.client.get(path, headers=other).status_code, 200)

    def test_room_delivery_requires_exact_reviewed_revision(self):
        owner = self.enroll()
        render_id = self.render(owner)
        patient = self.client.post("/api/rooms").json()
        invite = {key: patient[key] for key in ("room_id", "invite")}
        desk = self.client.post("/api/rooms/join", json=invite).json()
        query = "?room_id=" + patient["room_id"]
        commit = event("patient.commit", turn_id=str(uuid4()), revision=1, intent="message",
                       approved_text="Hello", voice_render=render_id)
        attach = {key: commit[key] for key in ("event_id", "turn_id", "revision")}
        attach["render_id"] = render_id
        endpoint = "/api/voice/messages/" + commit["event_id"] + query
        desk_auth = {"Authorization": "Bearer " + desk["token"]}
        attach_headers = {"X-Voice-Token": owner["Authorization"].split()[1]}
        self.assertEqual(self.client.post("/api/voice/attach" + query, json=attach,
                                          headers={**desk_auth, **attach_headers}).status_code, 403)
        attach_headers["Authorization"] = "Bearer " + patient["token"]
        self.assertEqual(self.client.post("/api/voice/attach" + query, json=attach,
                                          headers=attach_headers).status_code, 200)
        self.assertEqual(self.client.get(endpoint, headers=desk_auth).status_code, 404)
        with self.client.websocket_connect("/api/relay", headers=ORIGIN) as socket:
            socket.send_json({key: patient[key] for key in ("room_id", "token")})
            receive(socket, "room.snapshot")
            for changed in ({"approved_text": "Goodbye"}, {"revision": 2}):
                socket.send_json({**commit, **changed})
                self.assertEqual(socket.receive_json()["code"], "voice_mismatch")
            socket.send_json(commit)
            receive(socket, "patient.message")
        self.assertEqual(self.client.get(endpoint, headers=desk_auth).content, self.audio)
        self.assertEqual(self.client.get(endpoint).status_code, 401)
        self.client.delete("/api/voice/profile", headers=owner)
        self.assertEqual(self.client.get(endpoint, headers=desk_auth).status_code, 404)

    def test_phone_submission_is_scoped_approved_and_idempotent(self):
        owner = self.enroll()
        owner_id = self.client.get("/api/voice/status", headers=owner).json()["profile_id"]
        clip = "/api/voice/renders/" + self.render(owner)
        env = {"SVARA_TWILIO_ACCOUNT": "AC" + "0" * 32, "SVARA_TWILIO_TOKEN": "test",
               "SVARA_PUBLIC_ORIGIN": "https://voice.example.org", "SVARA_PHONE_PROFILE": owner_id,
               "SVARA_PHONE_FROM": "+12025550101", "SVARA_PHONE_TO": "+12025550102"}
        with patch.dict(os.environ, env), patch("httpx.AsyncClient.post", new_callable=AsyncMock) as provider:
            self.assertIsNone(self.client.get("/api/voice/status").json()["phone_destination"])
            other = self.enroll()
            other_clip = "/api/voice/renders/" + self.render(other)
            self.client.post(other_clip + "/approve", headers=other)
            self.assertEqual(self.client.post(other_clip + "/call", headers=other).status_code, 503)
            self.assertEqual(self.client.post(clip + "/call", headers=owner).json()["code"], "approval_required")
            self.client.post(clip + "/approve", headers=owner)
            provider.return_value = httpx.Response(201)
            for _ in range(2):
                self.assertEqual(self.client.post(clip + "/call", headers=owner).json()["status"], "queued")
            provider.assert_awaited_once()
            data = provider.await_args.kwargs["data"]
            self.assertEqual(data["To"], env["SVARA_PHONE_TO"])
            url = urlsplit(ElementTree.fromstring(data["Twiml"]).findtext("Play"))
            self.assertEqual(url.netloc, "voice.example.org")
            self.assertEqual(self.client.get(url.path).content, self.audio)
            self.client.delete("/api/voice/profile", headers=owner)
            self.assertEqual(self.client.get(url.path).status_code, 404)
