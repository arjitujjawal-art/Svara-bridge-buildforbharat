import asyncio
import io
import json
import unittest
import wave
from contextlib import contextmanager
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from api.main import create_app
from api.speech import Audio, Speech


ORIGIN = {"Origin": "http://testserver"}
SLOT = {"date": "2026-12-04", "time": "17:00", "timezone": "Asia/Kolkata"}
ALTERNATE = {"date": "2026-11-30", "time": "16:00", "timezone": "Asia/Kolkata"}


def event(kind, **values):
    return {"type": kind, "event_id": str(uuid4()), **values}


def receive(socket, kind):
    while True:
        message = socket.receive_json()
        if message["type"] == kind:
            return message
        if message["type"].endswith(".error"):
            raise AssertionError(message)


def wav(rate=16000, data=b"\x01\x00" * 160):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(data)
    return output.getvalue()


class ExchangeTests(unittest.TestCase):
    def setUp(self):
        self.client = self.enterContext(TestClient(create_app()))
        response = self.client.post("/api/rooms")
        self.assertEqual(response.status_code, 201)
        self.patient = response.json()
        self.invite = {key: self.patient[key] for key in ("room_id", "invite")}
        response = self.client.post("/api/rooms/join", json=self.invite)
        self.assertEqual(response.status_code, 200)
        self.desk = response.json()

    @contextmanager
    def peer(self, role, after=None):
        auth = getattr(self, role)
        with self.client.websocket_connect("/api/relay", headers=ORIGIN) as socket:
            socket.send_json({"room_id": auth["room_id"], "token": auth["token"], "after": after})
            if after is None:
                receive(socket, "room.snapshot")
            yield socket

    def offer(self, desk, value=SLOT):
        desk.send_json(event("desk.offer", slot=value))
        offer = receive(desk, "desk.offer")
        receive(desk, "command.ack")
        return offer

    def decide(self, offer_id, intent, **extra):
        return event("patient.commit", turn_id=str(uuid4()), revision=1,
                     approved_text="शुक्रवार शाम पाँच बजे नहीं।", intent=intent, offer_id=offer_id, **extra)

    def test_invite_and_roles(self):
        self.assertEqual(self.client.post("/api/rooms/join", json=self.invite).status_code, 403)
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect("/api/relay", headers={"Origin": "https://another.example"}):
                self.fail("Cross-origin relay accepted")
        with self.peer("patient") as patient:
            patient.send_json(event("desk.offer", slot=SLOT))
            self.assertEqual(patient.receive_json()["code"], "forbidden")
            with self.client.websocket_connect("/api/relay", headers=ORIGIN) as second:
                second.send_json({key: self.patient[key] for key in ("room_id", "token")})
                self.assertEqual(second.receive_json()["code"], "role_connected")
                self.assertEqual(second.receive()["code"], 1008)

    def test_private_state_counter_receipts_and_replay(self):
        with self.peer("patient") as patient, self.peer("desk") as desk:
            offer = self.offer(desk)
            receive(patient, "desk.offer")
            offer_id = offer["appointment"]["offer_id"]
            patient.send_json(event("patient.draft", secret="must remain private"))
            self.assertEqual(patient.receive_json()["code"], "invalid_event")
            counter = self.decide(offer_id, "counter", requested_slot=ALTERNATE)
            patient.send_json(counter)
            confirmed_message = receive(desk, "patient.message")
            self.assertEqual(confirmed_message["appointment"]["status"], "countered")
            self.assertEqual(confirmed_message["decision"]["requested_slot"]["time"], "16:00:00")
            self.assertNotIn("must remain private", json.dumps(confirmed_message))
            receive(patient, "patient.message")
            first_ack = receive(patient, "command.ack")
            desk.send_json(event("peer.receipt", message_id=counter["event_id"], status="played"))
            self.assertEqual(desk.receive_json()["code"], "missing_delivery")
            desk.send_json(event("peer.receipt", message_id=counter["event_id"], status="delivered"))
            self.assertTrue(receive(patient, "peer.receipt")["delivered"])
            desk.send_json(event("peer.receipt", message_id=counter["event_id"], status="played"))
            self.assertEqual(receive(patient, "peer.receipt")["playback"], "played")
        with self.peer("patient", after=offer["seq"]) as patient:
            replay = [patient.receive_json() for _ in range(4)]
            self.assertEqual([item["type"] for item in replay],
                             ["patient.message", "peer.receipt", "peer.receipt", "room.resumed"])
            patient.send_json(counter)
            self.assertEqual(receive(patient, "command.ack"), first_ack)
            patient.send_json({**counter, "approved_text": "changed"})
            self.assertEqual(patient.receive_json()["code"], "event_id_conflict")
            patient.send_json({**counter, "event_id": str(uuid4())})
            self.assertEqual(patient.receive_json()["code"], "stale_revision")

    def test_replaced_offer_and_two_party_confirmation(self):
        with self.peer("patient") as patient, self.peer("desk") as desk:
            old = self.offer(desk)
            new = self.offer(desk, ALTERNATE)
            new_id = new["appointment"]["offer_id"]
            for _ in range(2):
                receive(patient, "desk.offer")
            patient.send_json(self.decide(old["appointment"]["offer_id"], "accept"))
            self.assertEqual(patient.receive_json()["code"], "stale_offer")
            desk.send_json(event("desk.confirm", offer_id=new_id))
            self.assertEqual(desk.receive_json()["code"], "stale_offer")
            patient.send_json(self.decide(new_id, "accept"))
            self.assertEqual(receive(desk, "patient.message")["appointment"]["status"], "accepted")
            desk.send_json(event("desk.confirm", offer_id=new_id))
            self.assertEqual(receive(patient, "desk.confirmed")["appointment"]["status"], "confirmed")
            desk.send_json(event("room.end"))
            receive(patient, "room.ended")
        with self.client.websocket_connect("/api/relay", headers=ORIGIN) as patient:
            patient.send_json({key: self.patient[key] for key in ("room_id", "token")})
            snapshot = patient.receive_json()
            self.assertTrue(snapshot["ended"])
            self.assertEqual(snapshot["history"], [])
            self.assertIsNone(snapshot["appointment"])

    def test_http_audio_validation_and_revision_contract(self):
        endpoint = (f"/api/turns/transcribe?room_id={self.patient['room_id']}"
                    f"&turn_id={uuid4()}&revision=1")
        headers = {"Authorization": f"Bearer {self.patient['token']}", "Content-Type": "audio/wav"}
        self.assertEqual(self.client.post(endpoint, content=wav(rate=8000), headers=headers).json()["code"],
                         "invalid_audio")
        self.assertEqual(self.client.post(endpoint, content=wav(data=b"\0\0"), headers=headers).json()["code"],
                         "silent_audio")
        limit = self.client.post(endpoint, content=b"x" * 970000, headers=headers)
        self.assertEqual(limit.status_code, 413)
        self.assertEqual(self.client.post(endpoint, content=wav()).status_code, 401)
        desk_headers = {**headers, "Authorization": f"Bearer {self.desk['token']}"}
        self.assertEqual(self.client.post(endpoint, content=wav(), headers=desk_headers).status_code, 403)
        with patch.object(Speech, "transcribe", return_value="सोमवार चार बजे") as mock:
            response = self.client.post(endpoint, content=wav(), headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["raw_text"], "सोमवार चार बजे")
            self.assertEqual(response.json()["revision"], 1)
            self.assertEqual(response.json()["audio_ms"], 10)
            mock.assert_awaited_once()


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_request_does_not_release_cpu_slot_early(self):
        speech = Speech()
        speech.asr_origin = "http://test.invalid"
        started = asyncio.Event()
        finish = asyncio.Event()

        async def fake_inference(_):
            started.set()
            await finish.wait()
            return "हिंदी"

        with patch.object(speech, "infer", side_effect=fake_inference):
            recording = Audio(wav(), 160)
            caller = asyncio.create_task(speech.transcribe(recording))
            await started.wait()
            caller.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await caller
            self.assertTrue(speech.asr_busy)
            finish.set()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertFalse(speech.asr_busy)


if __name__ == "__main__":
    unittest.main()
