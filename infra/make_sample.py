import subprocess
import tempfile
import wave
from pathlib import Path

parts = ("शुक्रवार शाम पाँच बजे नहीं।", "सोमवार चार बजे मिल सकता है?")
frames = []
with tempfile.TemporaryDirectory() as path:
    for index, text in enumerate(parts):
        file = Path(path) / f"{index}.wav"
        subprocess.run(["espeak-ng", "-v", "hi", "-s", "145", "-w", file, text], check=True)
        pcm = subprocess.check_output(
            ["ffmpeg", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1",
             "-c:a", "pcm_s16le", "-f", "s16le", "-"],
        )
        # Remove eSpeak's trailing padding before inserting a known 1.5 s gap.
        pcm = pcm.rstrip(b"\0")
        if len(pcm) % 2:
            pcm += b"\0"
        frames.append(pcm)

with wave.open("assets/sample.wav", "wb") as target:
    target.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    target.writeframes((b"\0" * 48000).join(frames))
