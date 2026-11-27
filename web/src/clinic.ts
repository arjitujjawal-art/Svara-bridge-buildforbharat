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

const dayPatterns = [
  /सोमवार|\bmonday\b/i, /मंगलवार|\btuesday\b/i, /बुधवार|\bwednesday\b/i,
  /गुरुवार|\bthursday\b/i, /शुक्रवार|\bfriday\b/i, /शनिवार|\bsaturday\b/i,
  /रविवार|\bsunday\b/i,
];
const hourPatterns = [
  /(?:एक|ek|1)/, /(?:दो|do|2)/, /(?:तीन|teen|3)/, /(?:चार|chaar|char|4)/,
  /(?:पाँच|पांच|paanch|panch|5)/, /(?:छह|छः|chhe|6)/, /(?:सात|saat|7)/, /(?:आठ|aath|8)/,
  /(?:नौ|nau|9)/, /(?:दस|das|10)/, /(?:ग्यारह|gyarah|11)/, /(?:बारह|barah|12)/,
];

export type Interpreted = { rejected: boolean; date: string; hour: number | null; period: "" | "am" | "pm" };

export function interpret(text: string): Interpreted {
  const normalized = text.toLowerCase().replace(/[०-९]/g, digit => String(digit.charCodeAt(0) - 2406));
  const refusal = /नहीं|नही|\b(?:nahi|nahin)\b/.exec(normalized);
  const candidate = refusal ? normalized.slice(refusal.index + refusal[0].length) : normalized;
  const matches = dayPatterns.flatMap((pattern, index) => pattern.test(candidate) ? [index] : []);
  let date = "";
  if (matches.length === 1) {
    const resolved = new Date(`${REFERENCE_MONDAY}T00:00:00Z`);
    resolved.setUTCDate(resolved.getUTCDate() + matches[0]);
    date = resolved.toISOString().slice(0, 10);
  }
  const hour = hourPatterns.flatMap((pattern, index) => new RegExp(
    `(?:^|[\\s,।])${pattern.source}\\s+(?:बजे|baje)(?=$|[\\s,।?])`, "u",
  ).test(candidate) ? [index + 1] : []);
  const am = /सुबह|\b(?:subah|am)\b/.test(candidate);
  const pm = /शाम|दोपहर|\b(?:shaam|sham|dopahar|pm)\b/.test(candidate);
  const ambiguous = /(?:^|[\s,।])(?:या|ya|or)(?=$|[\s,।])/.test(candidate)
    || /नहीं|नही|\b(?:nahi|nahin)\b/.test(candidate);
  return {
    rejected: !!refusal, date,
    hour: !ambiguous && hour.length === 1 ? hour[0] : null,
    period: am === pm ? "" : am ? "am" : "pm",
  };
}
