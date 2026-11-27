"""Run against a built app with the local Hindi TTS service available."""
import os
import re
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ORIGIN = os.environ.get("SVARA_TEST_ORIGIN", "http://127.0.0.1:8080")


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH"),
        )
        patient = browser.new_context(viewport={"width": 320, "height": 780}).new_page()
        desk = browser.new_context().new_page()
        errors = []
        for page in (patient, desk):
            page.on("pageerror", lambda error: errors.append(str(error)))

        patient.goto(f"{ORIGIN}/patient")
        patient.get_by_role("button", name="Call my clinic").click()
        invite = patient.get_by_role("link", name="Open clinic desk").get_attribute("href")
        assert invite
        desk.goto(invite)
        expect(desk.get_by_text("Connected.", exact=True)).to_be_visible()
        assert not urlsplit(desk.url).fragment

        desk.get_by_label("Date").fill("2026-12-03")
        desk.get_by_label("Time in India").fill("15:30")
        desk.get_by_role("button", name="Send offer").click()
        expect(patient.get_by_text("Offer open")).to_be_visible()
        patient.get_by_role("button", name="Play clinic offer").click()
        expect(desk.get_by_text("Played", exact=True)).to_be_visible(timeout=20000)
        patient.get_by_role("button", name="Request another time").click()
        patient.get_by_label("Requested date").fill("2026-11-30")
        patient.get_by_label("Requested time in India").fill("16:00")
        expect(patient.get_by_role("button", name="Approve and send")).to_be_disabled()
        expect(desk.get_by_text("Patient", exact=True)).to_have_count(0)
        patient.get_by_role("button", name="Read back privately").click()
        expect(patient.get_by_role("button", name="Approve and send")).to_be_enabled(timeout=25000)
        expect(desk.get_by_text("Patient", exact=True)).to_have_count(0)
        patient.get_by_role("button", name="Approve and send").click()
        expect(desk.get_by_text("Counteroffer sent")).to_be_visible()
        patient_text = desk.locator(".history li").last.locator("p")
        expect(patient_text).to_contain_text("नहीं")
        expect(patient_text).to_contain_text("सोमवार")
        desk.get_by_role("button", name="Play patient message").click()
        expect(patient.get_by_text("Played", exact=True)).to_have_count(2, timeout=25000)

        desk.get_by_label("Date").fill("2026-11-30")
        desk.get_by_label("Time in India").fill("16:00")
        desk.get_by_role("button", name="Send offer").click()
        patient.get_by_role("button", name="Accept for review").click()
        patient.get_by_role("button", name="I reviewed the caption").click()
        patient.get_by_role("button", name="Approve and send").click()
        expect(patient.get_by_text("Patient accepted · clinic confirmation pending")).to_be_visible()
        desk.get_by_role("button", name="Confirm this appointment").click()
        expect(patient.get_by_text("Confirmed by clinic")).to_be_visible()

        patient.get_by_role("button", name="Start scanning").click()
        expect(patient.locator("button.scan")).to_have_count(1)
        assert patient.evaluate("document.documentElement.scrollWidth <= innerWidth")
        patient.get_by_role("button", name="End call").click()
        expect(desk.get_by_text("Call ended.")).to_be_visible()

        solo = browser.new_context().new_page()
        solo.on("pageerror", lambda error: errors.append(str(error)))
        solo.goto(f"{ORIGIN}/patient")
        solo.get_by_role("button", name="Try a sample call").click()
        expect(solo.get_by_text("Connected. · Simulated clinic desk")).to_be_visible()
        expect(solo.get_by_text("Offer open")).to_be_visible()
        solo.get_by_role("button", name="Use example transcript (no recognition)").click()
        expect(solo.get_by_text("Did you mean 4 in the morning or later in the day?")).to_be_visible()
        expect(solo.get_by_role("button", name="Approve and send")).to_be_disabled()
        solo.get_by_role("button", name="Afternoon or evening").click()
        solo.get_by_role("button", name="I reviewed the caption").click()
        solo.get_by_role("button", name="Approve and send").click()
        expect(solo.get_by_text("Counteroffer sent")).to_be_visible()
        lab = browser.new_context().new_page()
        lab.on("pageerror", lambda error: errors.append(str(error)))
        lab.goto(f"{ORIGIN}/lab")
        lab.get_by_role("button", name="Compare sample recording").click()
        expect(lab.get_by_text("Comparison complete.")).to_be_visible(timeout=30000)
        clips = lab.get_by_text(re.compile(r"^Cut at [0-9.]+ seconds$")).all_text_contents()
        cutoffs = [float(text.split()[2]) for text in clips]
        assert len(cutoffs) == 2 and cutoffs[1] > cutoffs[0], cutoffs
        print(f"Silero cutoffs from the same fixture: {cutoffs[0]:.2f}s and {cutoffs[1]:.2f}s.")
        assert not errors, errors
        print("Human desk workflow and simulated-desk clarification both passed.")
        browser.close()


if __name__ == "__main__":
    run()
