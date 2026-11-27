import asyncio
import hashlib
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID, uuid4

from .protocol import Action, Confirm, Decision, End, Offer, Receipt, Role, Slot

ROOM_IDLE = 1800
INVITE_TTL = 600
MAX_ROOMS = 64
MAX_HISTORY = 64
MAX_COMMANDS = 512


class RoomError(Exception):
    def __init__(self, code: str, detail: str, status: int = 409):
        self.code = code
        self.detail = detail
        self.status = status
        super().__init__(detail)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class Appointment:
    offer_id: UUID
    slot: Slot
    status: Literal["open", "declined", "countered", "accepted", "confirmed"] = "open"

    def snapshot(self) -> dict:
        return {
            "offer_id": str(self.offer_id),
            "slot": self.slot.model_dump(mode="json"),
            "status": self.status,
        }


@dataclass
class Room:
    patient_key: str
    invite_key: str | None
    id: UUID = field(default_factory=uuid4)
    desk_key: str | None = None
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    seq: int = 0
    ended: bool = False
    appointment: Appointment | None = None
    events: deque = field(default_factory=lambda: deque(maxlen=MAX_HISTORY))
    messages: dict = field(default_factory=dict)
    commands: dict = field(default_factory=dict)
    revisions: dict = field(default_factory=dict)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    speech_jobs: set = field(default_factory=set)
    connections: set = field(default_factory=set)

    def expired(self) -> bool:
        return time.monotonic() >= self.touched + ROOM_IDLE

    def emit(self, event_type: str, **data) -> dict:
        self.seq += 1
        event = {"type": event_type, "seq": self.seq, **data}
        self.events.append(event)
        if event_type in ("patient.message", "desk.offer"):
            self.messages[event["message_id"]] = {
                "event": event,
                "delivered": False,
                "playback": None,
            }
            if len(self.messages) > MAX_HISTORY:
                del self.messages[next(iter(self.messages))]
        self.changed.notify_all()
        return event

    def snapshot(self) -> dict:
        return {
            "type": "room.snapshot",
            "seq": self.seq,
            "desk_connected": self.desk_key is not None,
            "ended": self.ended,
            "appointment": self.appointment.snapshot() if self.appointment else None,
            "history": [message.copy() for message in self.messages.values()],
        }

    def apply(self, role: Role, action: Action) -> int:
        key = str(action.event_id)
        payload = action.model_dump_json()
        previous = self.commands.get(key)
        if previous:
            previous_role, previous_payload, sequence = previous
            if (previous_role, previous_payload) != (role, payload):
                raise RoomError("event_id_conflict", "This event ID was already used.")
            return sequence

        if self.ended or self.expired():
            raise RoomError("room_ended", "Start a new room to continue.")
        if len(self.commands) >= MAX_COMMANDS and not isinstance(action, End):
            raise RoomError("room_full", "This room reached its turn limit. Start a new room.")

        if isinstance(action, Offer):
            self.require_role(role, "desk")
            if self.appointment and self.appointment.status == "confirmed":
                raise RoomError("already_confirmed", "Start a new room for another appointment.")
            self.appointment = Appointment(uuid4(), action.slot)
            event = self.emit(
                "desk.offer", sender=role, message_id=key, appointment=self.appointment.snapshot()
            )
        elif isinstance(action, Decision):
            self.require_role(role, "patient")
            event = self.commit(action)
        elif isinstance(action, Confirm):
            self.require_role(role, "desk")
            appointment = self.current_offer(action.offer_id, "accepted")
            appointment.status = "confirmed"
            event = self.emit("desk.confirmed", appointment=appointment.snapshot())
        elif isinstance(action, Receipt):
            event = self.receipt(role, action)
        else:
            self.ended = True
            self.invite_key = None
            # Keep only the command receipt needed for a retry of this hang-up.
            self.messages.clear()
            self.events.clear()
            self.commands.clear()
            self.revisions.clear()
            self.appointment = None
            event = self.emit("room.ended", sender=role)

        self.commands[key] = (role, payload, event["seq"])
        self.touched = time.monotonic()
        return event["seq"]

    @staticmethod
    def require_role(actual: Role, expected: Role) -> None:
        if actual != expected:
            raise RoomError("forbidden", "This role cannot perform that action.", 403)

    def current_offer(self, offer_id: UUID | None, status: str) -> Appointment:
        if (
            self.appointment is None
            or self.appointment.offer_id != offer_id
            or self.appointment.status != status
        ):
            raise RoomError("stale_offer", "That offer has changed. Review the current offer.")
        return self.appointment

    def commit(self, action: Decision) -> dict:
        if self.desk_key is None:
            raise RoomError("desk_missing", "Pair a clinic desk before sending.")
        if action.revision <= self.revisions.get(action.turn_id, 0):
            raise RoomError("stale_revision", "Review the latest revision before sending.")
        if (action.intent == "counter") != (action.requested_slot is not None):
            raise RoomError("invalid_slot", "A counteroffer needs a complete date and time.", 422)
        if action.intent == "message":
            if action.offer_id is not None:
                raise RoomError("invalid_offer", "A general message must omit the offer ID.", 422)
        else:
            appointment = self.current_offer(action.offer_id, "open")
            if action.intent == "accept":
                appointment.status = "accepted"
            elif action.intent == "decline":
                appointment.status = "declined"
            else:
                appointment.status = "countered"

        self.revisions[action.turn_id] = action.revision
        return self.emit(
            "patient.message",
            sender="patient",
            message_id=str(action.event_id),
            decision=action.model_dump(mode="json", exclude={"event_id", "type"}),
            appointment=self.appointment.snapshot() if self.appointment else None,
        )

    def receipt(self, role: Role, action: Receipt) -> dict:
        message_id = str(action.message_id)
        message = self.messages.get(message_id)
        if message is None:
            raise RoomError("unknown_message", "That message is no longer available.", 404)
        if message["event"]["sender"] == role:
            raise RoomError("forbidden", "Only the recipient can report receipt.", 403)
        if action.status == "delivered":
            message["delivered"] = True
        elif message["delivered"]:
            # Once heard, a failed replay cannot erase the earlier successful playback.
            if message["playback"] != "played":
                message["playback"] = action.status
        else:
            raise RoomError("missing_delivery", "Acknowledge delivery before playback.")
        return self.emit(
            "peer.receipt",
            message_id=message_id,
            delivered=message["delivered"],
            playback=message["playback"],
        )


class Rooms:
    def __init__(self) -> None:
        self.rooms: dict[UUID, Room] = {}

    def prune(self) -> None:
        for room_id in list(self.rooms):
            if self.rooms[room_id].expired():
                del self.rooms[room_id]

    def create(self) -> tuple[Room, str, str]:
        self.prune()
        if len(self.rooms) >= MAX_ROOMS:
            raise RoomError("rooms_busy", "Too many active rooms. Try again shortly.", 503)
        patient, invite = secrets.token_urlsafe(32), secrets.token_urlsafe(18)
        room = Room(digest(patient), digest(invite))
        self.rooms[room.id] = room
        return room, patient, invite

    def get(self, room_id: UUID) -> Room:
        self.prune()
        room = self.rooms.get(room_id)
        if room is None:
            raise RoomError("room_missing", "This room is unavailable. Start a new one.", 404)
        return room

    async def join(self, room_id: UUID, invite: str) -> str:
        room = self.get(room_id)
        async with room.changed:
            if (
                room.ended
                or room.expired()
                or room.invite_key is None
                or time.monotonic() >= room.created + INVITE_TTL
                or not secrets.compare_digest(room.invite_key, digest(invite))
            ):
                raise RoomError("invite_invalid", "This invite is no longer available.", 403)
            key = secrets.token_urlsafe(32)
            room.desk_key = digest(key)
            room.invite_key = None
            room.touched = time.monotonic()
            room.emit("desk.joined")
            return key

    def authenticate(self, room_id: UUID, token: str) -> tuple[Room, Role]:
        room = self.get(room_id)
        key = digest(token)
        if secrets.compare_digest(room.patient_key, key):
            return room, "patient"
        if room.desk_key and secrets.compare_digest(room.desk_key, key):
            return room, "desk"
        raise RoomError("forbidden", "Room credentials are invalid.", 403)
