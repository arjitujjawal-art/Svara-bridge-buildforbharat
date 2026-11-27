"""Drive the production AudioWorklet using the app's synthetic microphone fixture."""
import io
import os
import tempfile
import wave
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


def run():
    origin = os.environ.get("SVARA_TEST_ORIGIN", "http://127.0.0.1:8080")
    with tempfile.TemporaryDirectory() as directory, sync_playwright() as playwright:
        fixture = Path(directory) / "microphone.wav"
        with urlopen(f"{origin}/api/sample.wav", timeout=5) as response:
            fixture.write_bytes(response.read())
        browser = playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH"),
            args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                  f"--use-file-for-fake-audio-capture={fixture}%noloop"],
        )
        page = browser.new_context(permissions=["microphone"]).new_page()
        page.add_init_script("""
            window.testTracks = [];
            const fetchRequest = window.fetch.bind(window);
            window.fetch = async (url, init) => {
                if (String(url).startsWith("/api/turns/transcribe?") && init?.body instanceof Blob) {
                    window.testWav = Array.from(new Uint8Array(await init.body.arrayBuffer()));
                }
                return fetchRequest(url, init);
            };
            const getInput = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async (...args) => {
                const stream = await getInput(...args);
                window.testTracks.push(...stream.getAudioTracks());
                return stream;
            };
        """)
        page.goto(f"{origin}/patient")
        page.get_by_role("button", name="Try a sample call").click()
        expect(page.get_by_text("Offer open")).to_be_visible()
        with page.expect_request(lambda request: "/api/turns/transcribe?" in request.url, timeout=22000) as captured:
            page.get_by_role("button", name="Start speaking").click()
            expect(page.get_by_text("Listening. Take your time.")).to_be_visible()
        request = captured.value
        assert request.headers["content-type"] == "audio/wav"
        with wave.open(io.BytesIO(bytes(page.evaluate("window.testWav"))), "rb") as audio:
            assert (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) == (16000, 1, 2)
            duration = audio.getnframes() / audio.getframerate()
            assert 4 < duration < 20, duration
            assert any(audio.readframes(audio.getnframes()))
        page.wait_for_function("testTracks.length > 0 && testTracks.every(track => track.readyState === 'ended')")
        response = request.response()
        assert response is not None
        assert response.status in (200, 503), response.text()
        if response.status == 503:
            assert response.json()["code"] == "asr_unavailable"
        print(f"Automatic endpoint uploaded {duration:.2f}s of 16 kHz mono PCM and released the microphone."
              f" Recognition endpoint returned HTTP {response.status}.")
        browser.close()


if __name__ == "__main__":
    run()
