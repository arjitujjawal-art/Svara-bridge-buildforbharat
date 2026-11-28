import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from fastapi import FastAPI, Header, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import Field, StringConstraints, ValidationError
from starlette.requests import ClientDisconnect

from .protocol import ACTION, Payload, Text
from .personal import install_voice_routes
from .rooms import ROOM_IDLE, Room, RoomError, Rooms
from .speech import MAX_WAV, SAMPLE, Speech, read_audio

Token = Annotated[str, StringConstraints(min_length=20, max_length=64)]
DIST = Path(os.environ.get("SVARA_WEB_DIST", "/app/web/dist"))


class Join(Payload):
    room_id: UUID
    invite: Token


class RelayAuth(Payload):
    room_id: UUID
    token: Token
    after: Annotated[int, Field(ge=0)] | None = None


class Say(Payload):
    text: Text


def rejection(error: RoomError) -> dict:
    return {"code": error.code, "detail": error.detail}


def create_app() -> FastAPI:
    rooms, speech = Rooms(), Speech()

    @asynccontextmanager
    async def lifecycle(_: FastAPI):
        async def sweep() -> None:
            while True:
                await asyncio.sleep(30)
                rooms.prune()
                voice.prune()

        task = asyncio.create_task(sweep())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    app = FastAPI(lifespan=lifecycle, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def no_api_cache(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(RoomError)
    async def room_error(_: Request, error: RoomError):
        return JSONResponse(rejection(error), status_code=error.status)

    @app.get("/api/health")
    async def health():
        return await speech.health()

    @app.post("/api/rooms", status_code=201)
    async def create_room():
        room, token, invite = rooms.create()
        return {"room_id": room.id, "token": token, "invite": invite}

    @app.post("/api/rooms/join")
    async def join_room(body: Join):
        token = await rooms.join(body.room_id, body.invite)
        return {"room_id": body.room_id, "token": token}

    def authenticate(room_id: UUID, authorization: str):
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not 20 <= len(token) <= 64:
            raise RoomError("unauthorized", "Room credentials are required.", 401)
        room, role = rooms.authenticate(room_id, token)
        if room.ended:
            raise RoomError("room_ended", "Start a new room to continue.")
        return room, role

    voice = install_voice_routes(app, authenticate, rooms)

    @app.post("/api/speech", response_class=Response)
    async def say(body: Say, room_id: UUID, authorization: Annotated[str, Header()] = ""):
        room, _ = authenticate(room_id, authorization)
        wav = await speech.synthesize(body.text)
        if room.ended or room.expired():
            raise RoomError("room_ended", "Start a new room to continue.")
        return Response(wav, media_type="audio/wav")

    @app.get("/api/sample.wav")
    async def sample():
        if not SAMPLE.is_file():
            raise RoomError("sample_unavailable", "The sample audio is unavailable.", 404)
        return FileResponse(SAMPLE, media_type="audio/wav")

    @app.post("/api/turns/transcribe")
    async def transcribe(
        request: Request,
        room_id: UUID,
        turn_id: UUID,
        revision: Annotated[int, Query(ge=1, le=10000)],
        locale: Literal["hi-IN"] = "hi-IN",
        authorization: Annotated[str, Header()] = "",
    ):
        room, role = authenticate(room_id, authorization)
        Room.require_role(role, "patient")
        if request.headers.get("content-type", "").split(";")[0] != "audio/wav":
            raise RoomError("invalid_audio", "Send the recording as audio/wav.", 415)
        key = (turn_id, revision)
        if room.speech_jobs:
            raise RoomError("turn_busy", "A turn is already being processed.", 429)
        room.speech_jobs.add(key)
        try:
            buffer = bytearray()
            try:
                async with asyncio.timeout(10):
                    async for chunk in request.stream():
                        if len(buffer) + len(chunk) > MAX_WAV:
                            raise RoomError("audio_too_large", "Use up to 30 seconds of audio.", 413)
                        buffer.extend(chunk)
            except (TimeoutError, ClientDisconnect) as exc:
                raise RoomError("upload_interrupted", "Recording upload was interrupted. Retry.", 408) from exc
            audio = read_audio(bytes(buffer))
            started = time.monotonic()
            result = await speech.transcribe(audio)
            if room.ended or room.expired():
                raise RoomError("room_ended", "Start a new room to continue.")
            if revision <= room.revisions.get(turn_id, 0):
                raise RoomError("stale_revision", "Review the latest revision before sending.")
            return {
                "turn_id": turn_id, "revision": revision, "locale": locale,
                "raw_text": result, "audio_ms": round(audio.frames / 16),
                "processing_ms": round((time.monotonic() - started) * 1000),
            }
        finally:
            room.speech_jobs.discard(key)

    @app.websocket("/api/relay")
    async def relay(socket: WebSocket):
        host = socket.headers.get("host")
        if not host or socket.headers.get("origin") not in (f"http://{host}", f"https://{host}"):
            await socket.close(code=1008)
            return
        await socket.accept()
        room = None
        owns_connection = False
        try:
            auth = RelayAuth.model_validate_json(await asyncio.wait_for(socket.receive_text(), 5))
            room, role = rooms.authenticate(auth.room_id, auth.token)
            async with room.changed:
                if role in room.connections:
                    raise RoomError("role_connected", "This role already has a connected tab.")
                room.connections.add(role)
                owns_connection = True
                snapshot = room.snapshot()
                first = room.events[0]["seq"] if room.events else room.seq + 1
                replay = (
                    [event for event in room.events if event["seq"] > auth.after]
                    if auth.after is not None and first - 1 <= auth.after <= room.seq and not room.ended
                    else None
                )
            if replay is None:
                await socket.send_json(snapshot)
            else:
                for event in replay:
                    await socket.send_json(event)
                await socket.send_json({"type": "room.resumed", "seq": snapshot["seq"]})

            replies: asyncio.Queue[dict] = asyncio.Queue(maxsize=32)

            async def receive() -> None:
                while True:
                    raw = await socket.receive_text()
                    action = None
                    try:
                        action = ACTION.validate_json(raw)
                        async with room.changed:
                            seq = room.apply(role, action)
                        reply = {"type": "command.ack", "event_id": str(action.event_id), "seq": seq}
                    except ValidationError:
                        reply = {"type": "command.error", "code": "invalid_event",
                                 "detail": "The event data is invalid."}
                    except RoomError as error:
                        reply = {"type": "command.error", **rejection(error),
                                 "event_id": str(action.event_id)}
                    async with room.changed:
                        replies.put_nowait(reply)
                        room.changed.notify_all()

            async def publish(cursor: int) -> None:
                while True:
                    async with room.changed:
                        remaining = room.touched + ROOM_IDLE - time.monotonic()
                        if remaining > 0 and room.seq <= cursor and replies.empty():
                            try:
                                await asyncio.wait_for(room.changed.wait(), remaining)
                            except TimeoutError:
                                pass
                        if room.expired():
                            await socket.close(code=4001, reason="Room expired")
                            return
                        events = [event for event in room.events if event["seq"] > cursor]
                        if events and events[0]["seq"] > cursor + 1:
                            events = [room.snapshot()]
                        acks = []
                        while not replies.empty():
                            acks.append(replies.get_nowait())
                    for event in events:
                        await socket.send_json(event)
                        cursor = event["seq"]
                    for ack in acks:
                        await socket.send_json(ack)

            tasks = {asyncio.create_task(receive()), asyncio.create_task(publish(snapshot["seq"]))}
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except RoomError as error:
            await socket.send_json({"type": "connection.error", **rejection(error)})
            await socket.close(code=1008)
        except (ValidationError, TimeoutError, asyncio.QueueFull, KeyError, RuntimeError):
            try:
                await socket.close(code=1008)
            except (RuntimeError, WebSocketDisconnect):
                pass
        except WebSocketDisconnect:
            pass
        finally:
            if room is not None and owns_connection:
                async with room.changed:
                    room.connections.discard(role)

    if (DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    @app.get("/patient")
    @app.get("/desk")
    @app.get("/voice")
    @app.get("/lab")
    async def front_end():
        if not (DIST / "index.html").is_file():
            return Response("Build the web client first.", status_code=503)
        return FileResponse(DIST / "index.html")

    return app


app = create_app()
