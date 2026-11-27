import asyncio
import io
import os
import shutil
import wave
from dataclasses import dataclass
from pathlib import Path

import httpx

from .rooms import RoomError

MAX_FRAMES = 30 * 16000
MAX_WAV = MAX_FRAMES * 2 + 4096
SAMPLE = Path(os.environ.get("SVARA_SAMPLE", "/app/assets/sample.wav"))


@dataclass(frozen=True)
class Audio:
    wav: bytes
    frames: int


def read_audio(data: bytes) -> Audio:
    if len(data) > MAX_WAV:
        raise RoomError("audio_too_large", "Use up to 30 seconds of audio.", 413)

    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            frames = source.getnframes()
            if not (
                source.getframerate() == 16000
                and source.getnchannels() == 1
                and source.getsampwidth() == 2
                and 0 < frames <= MAX_FRAMES
            ):
                raise ValueError("wrong format")
            pcm = source.readframes(frames)
            if len(pcm) != frames * 2:
                raise ValueError("truncated PCM")
    except (EOFError, ValueError, wave.Error) as exc:
        raise RoomError("invalid_audio", "Send a 16 kHz mono PCM WAV up to 30 seconds.", 422) from exc

    if not any(pcm):
        raise RoomError("silent_audio", "No speech was captured. Try again.", 422)

    # Forward one canonical PCM chunk to the recogniser.
    result = io.BytesIO()
    with wave.open(result, "wb") as target:
        target.setparams((1, 2, 16000, frames, "NONE", "not compressed"))
        target.writeframes(pcm)
    return Audio(result.getvalue(), frames)


class Speech:
    def __init__(self) -> None:
        self.asr_origin = os.environ.get("SVARA_ASR_ORIGIN", "").rstrip("/")
        self.asr_busy = False
        self.tts_jobs = 0
        self.espeak = shutil.which("espeak-ng")

    async def health(self) -> dict:
        asr = "unconfigured"
        if self.asr_origin:
            asr = "unavailable"
            try:
                async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
                    response = await client.get(f"{self.asr_origin}/health")
                    if response.is_success:
                        asr = "ready"
            except httpx.HTTPError:
                pass
        return {
            "app": "ready",
            "asr": asr,
            "tts": "ready" if self.espeak else "unavailable",
            "sample": "ready" if SAMPLE.is_file() else "unavailable",
        }

    async def transcribe(self, audio: Audio) -> str:
        if not self.asr_origin:
            raise RoomError("asr_unavailable", "Local recognition is unavailable. Try a saved phrase.", 503)
        if self.asr_busy:
            raise RoomError("asr_busy", "The recogniser is busy. Retry this recording shortly.", 429)
        self.asr_busy = True
        job = asyncio.create_task(self.infer(audio))
        # A cancelled browser request must not open another slot while upstream still runs.
        job.add_done_callback(self.finish_asr)
        return await asyncio.shield(job)

    def finish_asr(self, job: asyncio.Task) -> None:
        self.asr_busy = False
        if not job.cancelled():
            job.exception()

    async def infer(self, audio: Audio) -> str:
        try:
            async with httpx.AsyncClient(timeout=45.0, trust_env=False) as client:
                response = await client.post(
                    f"{self.asr_origin}/inference",
                    data={"language": "hi", "translate": "false", "response_format": "json",
                          "temperature": "0.0", "temperature_inc": "0.0"},
                    files={"file": ("turn.wav", audio.wav, "audio/wav")},
                )
                response.raise_for_status()
                text = response.json()["text"]
                if not isinstance(text, str):
                    raise ValueError("invalid recogniser response")
                return text.strip()[:2000]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise RoomError("asr_unavailable", "Recognition failed. Retry or use a saved phrase.", 503) from exc

    async def synthesize(self, text: str) -> bytes:
        if not self.espeak:
            raise RoomError("tts_unavailable", "Hindi server speech is unavailable.", 503)
        if self.tts_jobs >= 2:
            raise RoomError("tts_busy", "Speech is busy. Retry playback shortly.", 429)
        self.tts_jobs += 1
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                self.espeak, "-v", "hi", "-s", "145", "--stdin", "--stdout",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            wav, _ = await asyncio.wait_for(process.communicate(text.encode("utf-8")), 8)
            if process.returncode or not wav.startswith(b"RIFF"):
                raise RoomError("tts_failed", "Speech failed. Try playback again.", 503)
            # Streaming WAV headers carry sentinel lengths; use the finished buffer sizes.
            if wav[36:40] == b"data":
                wav = (wav[:4] + (len(wav) - 8).to_bytes(4, "little") + wav[8:40]
                       + (len(wav) - 44).to_bytes(4, "little") + wav[44:])
            return wav
        except (TimeoutError, OSError) as exc:
            raise RoomError("tts_failed", "Speech failed. Try playback again.", 503) from exc
        finally:
            if process is not None and process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
            self.tts_jobs -= 1
