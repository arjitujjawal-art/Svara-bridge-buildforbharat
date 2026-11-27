from datetime import date, time
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, field_validator

Role = Literal["patient", "desk"]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Slot(Payload):
    date: date
    time: time
    timezone: Literal["Asia/Kolkata"] = "Asia/Kolkata"

    @field_validator("time")
    @classmethod
    def local_minutes(cls, value: time) -> time:
        if value.tzinfo is not None or value.second or value.microsecond:
            raise ValueError("Use the clinic's local time to minute precision")
        return value


class Command(Payload):
    event_id: UUID


class Offer(Command):
    type: Literal["desk.offer"]
    slot: Slot


class Decision(Command):
    type: Literal["patient.commit"]
    turn_id: UUID
    revision: Annotated[int, Field(strict=True, ge=1, le=10000)]
    approved_text: Text
    intent: Literal["message", "decline", "counter", "accept"]
    offer_id: UUID | None = None
    requested_slot: Slot | None = None


class Confirm(Command):
    type: Literal["desk.confirm"]
    offer_id: UUID


class Receipt(Command):
    type: Literal["peer.receipt"]
    message_id: UUID
    status: Literal["delivered", "played", "failed"]


class End(Command):
    type: Literal["room.end"]


Action = Offer | Decision | Confirm | Receipt | End
ACTION = TypeAdapter(Annotated[Action, Field(discriminator="type")])
