import type { Slot } from "./relay";

export const REFERENCE_MONDAY = "2026-11-30";

export function slot(date: string, time: string): Slot {
  return { date, time: time.slice(0, 5), timezone: "Asia/Kolkata" };
}

export function displaySlot(value: Slot) {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long", day: "numeric", month: "short", hour: "numeric",
    minute: "2-digit", timeZone: value.timezone,
  }).format(new Date(`${value.date}T${value.time.slice(0, 5)}:00+05:30`));
}

const days = ["सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार", "रविवार"];
const months = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
const numbers = [
  "शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ", "दस", "ग्यारह", "बारह",
  "तेरह", "चौदह", "पंद्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस", "बीस", "इक्कीस", "बाईस",
  "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस", "तीस", "इकतीस",
];

export function speakSlot(value: Slot) {
  const date = new Date(`${value.date}T00:00:00Z`);
  const [hour, minute] = value.time.split(":").map(Number);
  const minuteText = minute ? ` और ${numbers[minute] ?? minute} मिनट` : "";
  const period = hour < 4 || hour >= 21 ? "रात" : hour < 12 ? "सुबह" : hour < 16 ? "दोपहर" : "शाम";
  return `${days[(date.getUTCDay() + 6) % 7]}, ${numbers[date.getUTCDate()]} ${months[date.getUTCMonth()]}, ${period} ${numbers[hour % 12 || 12]} बजे${minuteText}`;
}

export const SAMPLE_TEXT = "शुक्रवार शाम पाँच बजे नहीं। सोमवार चार बजे मिल सकता है?";
