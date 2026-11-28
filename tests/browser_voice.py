"""Exercise local conditioning and synthesis through the UI with a synthetic speaker."""
import io
import os
import tempfile
import wave
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


def run():
    origin = os.getenv("SVARA_TEST_ORIGIN", "http://127.0.0.1:8080")
    with urlopen(origin + "/api/sample.wav", timeout=10) as source:
        reference = source.read()
    with tempfile.TemporaryDirectory() as directory, sync_playwright() as playwright:
        microphone = Path(directory) / "microphone.wav"
        microphone.write_bytes(reference)
        browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"), args=[
            "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={microphone}"])
        patient = browser.new_page(permissions=["microphone"])
        desk = browser.new_page()
        button = lambda name: patient.get_by_role("button", name=name, exact=True)
        patient.goto(origin + "/voice")
        patient.get_by_label("Reference recordings").set_input_files({
            "name": "synthetic.wav", "mimeType": "audio/wav", "buffer": reference})
        expect(button("Create my voice")).to_be_disabled()
        patient.get_by_role("checkbox").check()
        button("Create my voice").click()
        expect(patient.get_by_role("heading", name="Compose a message")).to_be_visible(timeout=120000)
        token = patient.evaluate("localStorage.getItem('svara.personalVoice.v1')")
        try:
            # A sleeping studio may hold an expired dictation room. Reuse the same
            # captured turn for one retry, then let the live recognizer answer.
            patient.route("**/api/turns/transcribe?*", lambda route: route.fulfill(
                status=404, json={"code": "room_missing", "detail": "Room expired."}), times=1)
            button("Dictate in Hindi or Hinglish").click()
            expect(button("Finish speaking")).to_be_visible()
            patient.wait_for_timeout(4500)
            with patient.expect_response(lambda r: "/api/turns/transcribe?" in r.url and r.status == 200,
                                         timeout=60000):
                button("Finish speaking").click()
            expect(patient.get_by_label("What would you like to say?")).not_to_have_value("")
            patient.get_by_label("Spoken language").select_option("en")
            button("I need some water.").click()
            button("Generate private preview").click()
            approve = button("Approve this audio")
            expect(approve).to_be_visible(timeout=120000)
            expect(approve).to_be_disabled()
            button("Play private preview").click()
            expect(approve).to_be_enabled(timeout=30000)
            approve.click()
            with patient.expect_download() as download:
                patient.get_by_role("link", name="Download voice message").click()
            with wave.open(str(download.value.path())) as audio:
                assert audio.getframerate() == 24000 and audio.getnframes() > 8000
            button("Please give me a moment.").click()
            expect(patient.get_by_role("link", name="Download voice message")).to_have_count(0)

            patient.goto(origin + "/patient")
            button("Call my clinic").click()
            desk.goto(patient.get_by_role("link", name="Open clinic desk").get_attribute("href"))
            button("Write a message").click()
            patient.get_by_role("textbox", name="Message", exact=True).fill("मुझे पानी चाहिए।")
            expect(button("I reviewed the caption")).to_be_disabled()
            with patient.expect_response(lambda r: "/api/voice/renders/" in r.url and r.request.method == "GET",
                                         timeout=120000) as preview:
                button("Read back privately").click()
            audio_bytes = preview.value.body()
            with wave.open(io.BytesIO(audio_bytes)) as audio:
                assert audio.getframerate() == 24000 and audio.getnframes() > 8000
            expect(button("Approve and send")).to_be_enabled(timeout=30000)
            expect(desk.get_by_text("Personal AI voice")).to_have_count(0)
            button("Approve and send").click()
            expect(desk.get_by_text("Personal AI voice")).to_be_visible()
            with desk.expect_response(lambda r: "/api/voice/messages/" in r.url) as delivered:
                desk.get_by_role("button", name="Play patient message").click()
            assert delivered.value.body() == audio_bytes
            expect(desk.get_by_text("Played", exact=True)).to_be_visible(timeout=30000)
            patient.goto(origin + "/voice")
            button("Remove profile").click()
            button("Delete my voice profile").click()
            expect(button("Create my voice")).to_be_visible()
            assert patient.request.get(origin + "/api/voice/profile",
                                       headers={"Authorization": "Bearer " + token}).status == 401
        finally:
            patient.request.delete(origin + "/api/voice/profile", headers={"Authorization": "Bearer " + token})
            browser.close()
        print("Synthetic profile enrolled and revoked. English WAV exported. Desk played the exact reviewed Hindi WAV.")


if __name__ == "__main__":
    run()
