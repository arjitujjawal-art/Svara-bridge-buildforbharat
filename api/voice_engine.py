"""CPU inference for the pinned Chatterbox Multilingual ONNX export (MIT).

The conditioning arrays are the personal voice profile. The general model weights
are shared. See voice/model.json and the upstream model card for the graph ABI.
"""
import io
import re
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from .rooms import RoomError

RATE = 24000
START, STOP = 6561, 6562


def reference_pcm(blob: bytes) -> np.ndarray:
    try:
        with wave.open(io.BytesIO(blob)) as source:
            count = source.getnframes()
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, RATE):
                raise ValueError()
            if not 3 * RATE <= count <= 15 * RATE:
                raise ValueError()
            pcm = np.frombuffer(source.readframes(count), dtype="<i2").astype(np.float32) / 32768
            if pcm.size != count or pcm.std() < 0.003:
                raise ValueError()
            return pcm[None, :]
    except (ValueError, EOFError, wave.Error) as exc:
        raise RoomError("reference_invalid", "Use 3–15 seconds of clear speech in a mono 24 kHz PCM WAV.", 422) from exc


def segments(text: str) -> list[str]:
    # Split long turns at word boundaries. Synthesize every segment or fail the render.
    parts = []
    for sentence in re.split(r"(?<=[।.!?])\s+", text.strip()):
        chunk = ""
        for word in sentence.split():
            if len(word) > 160:
                raise RoomError("voice_text", "Shorten the long word and try again.", 422)
            if chunk and len(chunk) + len(word) >= 160:
                parts.append(chunk)
                chunk = ""
            chunk = (chunk + " " + word).strip()
        if chunk:
            parts.append(chunk)
    return parts


class VoiceEngine:
    def __init__(self, root: Path):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 3
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))

        def session(name):
            return ort.InferenceSession(str(root / "onnx" / (name + ".onnx")), options,
                                        providers=["CPUExecutionProvider"])

        self.encoder = session("speech_encoder")
        self.embed = session("embed_tokens")
        self.language = session("language_model_q4")
        self.decoder = session("conditional_decoder")

    def enroll(self, pcm):
        outputs = self.encoder.run(None, {"audio_values": pcm})
        return dict(zip(("condition", "prompt", "speaker", "features"), outputs, strict=True))

    def utterance(self, text, language, profile):
        ids = np.array([self.tokenizer.encode(f"[{language}]{text}").ids], dtype=np.int64)
        positions = np.where(ids >= START, 0, np.arange(ids.shape[1])[None, :] - 1)
        cache = {item.name: np.empty((1, 16, 0, 64), dtype=np.float32)
                 for item in self.language.get_inputs() if item.name.startswith("past_key_values.")}
        generated = [START]
        for step in range(420):
            embeds = self.embed.run(None, {"input_ids": ids, "position_ids": positions,
                                           "exaggeration": np.array([0.5], np.float32)})[0]
            if step == 0:
                embeds = np.concatenate((profile["condition"], embeds), axis=1)
                mask = np.ones(embeds.shape[:2], dtype=np.int64)
            logits, *present = self.language.run(None, {"inputs_embeds": embeds, "attention_mask": mask, **cache})
            scores = logits[0, -1].copy()
            used = np.unique(generated)
            scores[used] = np.where(scores[used] < 0, scores[used] * 1.2, scores[used] / 1.2)
            token = int(scores.argmax())
            if token == STOP and len(generated) > 1:
                break
            generated.append(token)
            ids = np.array([[token]], dtype=np.int64)
            positions = np.array([[step + 1]], dtype=np.int64)
            mask = np.pad(mask, ((0, 0), (0, 1)), constant_values=1)
            cache = dict(zip(cache, present, strict=True))
        else:
            raise RoomError("voice_incomplete", "Speech generation did not finish. Try a shorter sentence.", 422)
        tokens = np.concatenate((profile["prompt"], np.array([generated[1:]], np.int64)), axis=1)
        waveform = self.decoder.run(None, {"speech_tokens": tokens, "speaker_embeddings": profile["speaker"],
                                           "speaker_features": profile["features"]})[0].reshape(-1)
        if not waveform.size or not np.isfinite(waveform).all() or waveform.std() < 0.0001:
            raise RoomError("voice_empty", "The model produced no usable audio. Try another reference.", 422)
        return (np.clip(waveform, -1, 1) * 32767).astype("<i2").tobytes()

    def render(self, text, language, profile):
        output = io.BytesIO()
        with wave.open(output, "wb") as target:
            target.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
            for part in segments(text):
                target.writeframes(self.utterance(part, language, profile))
        return output.getvalue()
