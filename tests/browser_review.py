"""Inject transcripts at the ASR boundary and exercise private review against a real desk."""
import os
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ORIGIN = os.environ.get("SVARA_TEST_ORIGIN", "http://127.0.0.1:8080")


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"),
                                             args=["--use-fake-device-for-media-stream"])
        patient = browser.new_context(permissions=["microphone"]).new_page()
        desk = browser.new_context().new_page()
        patient.goto(f"{ORIGIN}/patient")
        patient.get_by_role("button", name="Call my clinic").click()
        desk.goto(patient.get_by_role("link", name="Open clinic desk").get_attribute("href"))
        desk.get_by_role("button", name="Send offer").click()
        expect(patient.get_by_text("Offer open", exact=True)).to_be_visible()

        ambiguous = "Paanch baje nahi. Monday chaar ya saat baje milega?"
        conditional = "Haan, lekin Monday ko agar doctor Sharma hain"
        transcripts = iter([None, ambiguous, conditional, ambiguous, "शाम"])

        def stub_recogniser(route):
            query = parse_qs(urlsplit(route.request.url).query)
            raw = next(transcripts)
            route.fulfill(json={
                "turn_id": query["turn_id"][0] if raw else "previous-turn",
                "revision": int(query["revision"][0]), "raw_text": raw or ambiguous, "audio_ms": 1200,
            })

        patient.route("**/api/turns/transcribe?*", stub_recogniser)
        sample = patient.get_by_role("button", name="Use sample recording")
        approve = patient.get_by_role("button", name="Approve and send")
        reviewed = patient.get_by_role("button", name="I reviewed the caption")
        sample.click()
        expect(patient.get_by_role("alert")).to_contain_text("different recording")
        expect(patient.get_by_role("heading", name="Private review")).to_have_count(0)
        sample.click()
        expect(patient.get_by_text("Which hour did you mean?")).to_be_visible()
        expect(approve).to_be_disabled()
        patient.get_by_role("button", name="7 o’clock").click()
        patient.get_by_role("button", name="Afternoon or evening").click()
        reviewed.click()
        expect(approve).to_be_enabled()
        patient.get_by_label("Requested time in India").fill("18:30")
        expect(approve).to_be_disabled()
        reviewed.click()
        desk.get_by_label("Time in India").fill("10:00")
        desk.get_by_role("button", name="Send offer").click()
        expect(patient.get_by_text("The clinic changed the offer.", exact=False)).to_be_visible()
        expect(approve).to_be_disabled()
        expect(desk.get_by_text("Patient", exact=True)).to_have_count(0)
        patient.get_by_role("button", name="Cancel draft").click()

        sample.click()
        expect(patient.get_by_role("textbox", name="Message", exact=True)).to_have_value(conditional)
        reviewed.click()
        approve.click()
        expect(desk.locator(".history li").last.locator("p")).to_have_text(conditional)
        expect(desk.get_by_text("Offer open", exact=True)).to_be_visible()

        desk.get_by_label("Time in India").fill("17:00")
        desk.get_by_role("button", name="Send offer").click()
        expect(patient.locator(".appointment")).to_contain_text("5:00")
        sample.click()
        patient.get_by_role("button", name="4 o’clock").click()
        patient.get_by_role("button", name="Speak the missing time detail").click()
        patient.get_by_role("button", name="Finish recording").click()
        expect(patient.get_by_label("Requested time in India")).to_have_value("16:00")
        wording = patient.locator(".sentence").inner_text()
        assert "नहीं" in wording and "सोमवार" in wording and "चार बजे" in wording
        patient.get_by_role("button", name="Read back privately").click()
        expect(approve).to_be_enabled(timeout=25000)
        approve.click()
        expect(desk.get_by_text("Counteroffer sent", exact=True)).to_be_visible()
        expect(desk.locator(".history li").last.locator("p")).to_have_text(wording)
        browser.close()
        print("Two-client review passed for ambiguous hours, stale offers, and conditional speech.")


if __name__ == "__main__":
    run()
