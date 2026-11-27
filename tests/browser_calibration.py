"""Exercise optional pre-call calibration with real Silero and a synthetic microphone."""
import json
import os
import tempfile
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
                  f"--use-file-for-fake-audio-capture={fixture}"],
        )
        page = browser.new_context(permissions=["microphone"]).new_page()
        outbound = []
        page.on("request", lambda request: outbound.append(request.url) if request.method == "POST" else None)
        page.goto(f"{origin}/patient")
        preference = page.get_by_label("Pause before finishing a recording")
        preference.select_option("0")
        page.get_by_role("button", name="Find my pause time").click()
        page.get_by_role("button", name="Record phrase").click()
        expect(page.get_by_role("button", name="Finish phrase")).to_be_visible()
        page.get_by_role("button", name="Cancel calibration").click()
        expect(preference).to_have_value("0")

        page.get_by_role("button", name="Find my pause time").click()
        for index in range(1, 4):
            expect(page.get_by_role("heading", name=f"Phrase {index} of 3")).to_be_visible()
            page.get_by_role("button", name="Record phrase").click()
            finish = page.get_by_role("button", name="Finish phrase")
            expect(finish).to_be_visible()
            # Allow a complete spoken fixture with its internal pause through the worklet.
            page.wait_for_timeout(6600)
            finish.click()
        apply = page.get_by_role("button", name="Use suggested wait")
        expect(apply).to_be_visible(timeout=15000)
        assert json.loads(page.evaluate('localStorage.getItem("svara.patient.timing")'))["waitMs"] == 0
        apply.click()
        value = int(preference.input_value())
        assert 2500 <= value <= 4000
        page.reload()
        expect(preference).to_have_value(str(value))
        lab = page.context.new_page()
        lab.goto(f"{origin}/lab")
        lab.get_by_role("button", name="Compare sample recording").click()
        expect(lab.get_by_text("Comparison complete.")).to_be_visible(timeout=30000)
        if value != 3000:
            expect(lab.get_by_role("heading", name=f"My pause time · {value:,} ms")).to_be_visible()
        lab.close()
        page.get_by_role("button", name="Reset pause preference").click()
        page.reload()
        expect(preference).to_have_value("3000")
        assert page.evaluate('localStorage.getItem("svara.patient.timing")') is None
        assert not outbound, outbound
        print(f"Three synthetic phrases produced {value} ms. Apply, reload, cancellation and reset passed.")
        browser.close()


if __name__ == "__main__":
    run()
