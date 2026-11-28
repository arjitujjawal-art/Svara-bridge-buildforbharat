import { REFERENCE_MONDAY, slot, speakSlot } from "./clinic.ts";
import type { Appointment, Decision } from "./relay";

const weekdays = [
  ["सोमवार", "somvar", "monday"], ["मंगलवार", "mangalvar", "tuesday"],
  ["बुधवार", "budhvar", "wednesday"], ["गुरुवार", "guruvar", "thursday"],
  ["शुक्रवार", "shukravar", "friday"], ["शनिवार", "shanivar", "saturday"],
  ["रविवार", "ravivar", "sunday"],
];
const numbers = [
  ["एक", "ek"], ["दो", "do"], ["तीन", "teen"], ["चार", "char", "chaar"],
  ["पाँच", "पांच", "panch", "paanch"], ["छः", "छह", "chhe"], ["सात", "saat"],
  ["आठ", "aath"], ["नौ", "nau"], ["दस", "das"], ["ग्यारह", "gyarah"], ["बारह", "barah"],
];
type Period = "" | "am" | "pm";

function periodOf(word?: string): Period {
  if (["सुबह", "subah", "am"].includes(word ?? "")) return "am";
  if (["शाम", "दोपहर", "shaam", "sham", "dopahar", "pm"].includes(word ?? "")) return "pm";
  return "";
}

function hourOf(word: string | undefined): number | null {
  if (!word) return null;
  if (/^(?:[1-9]|1[0-2])$/.test(word)) return Number(word);
  const value = numbers.findIndex(forms => forms.includes(word));
  return value < 0 ? null : value + 1;
}

type SlotWords = { weekday: number; hours: number[]; period: Period };

// Consume the entire clause. Unconsumed words may carry conditions, names,
// additional times or negation and must survive in the verbatim draft.
function parseSlot(words: string[]): SlotWords | null {
  let i = 0;
  const weekday = weekdays.findIndex(forms => forms.includes(words[i]));
  if (weekday >= 0) {
    i++;
    if (["को", "ko"].includes(words[i])) i++;
  }
  let period = periodOf(words[i]);
  if (period) i++;
  const hours: number[] = [];
  const first = hourOf(words[i]);
  if (first !== null) {
    i++;
    hours.push(first);
    if (["बजे", "baje"].includes(words[i])) i++;
    if (["या", "ya", "or"].includes(words[i])) {
      const other = hourOf(words[++i]);
      if (other === null || first === other) return null;
      hours.push(other);
      i++;
      if (["बजे", "baje"].includes(words[i])) i++;
    }
    const suffix = periodOf(words[i]);
    if (suffix) {
      if (period && period !== suffix) return null;
      period = suffix;
      i++;
    }
  }
  if (i !== words.length || (weekday < 0 && !hours.length) || (period && !hours.length)) return null;
  return { weekday, hours, period };
}

export function timeOf(hour: number, period: Period): string {
  if (!period) return "";
  return String(hour % 12 + (period === "pm" ? 12 : 0)).padStart(2, "0") + ":00";
}

function referenceDate(weekday: number) {
  if (weekday < 0) return "";
  const day = new Date(REFERENCE_MONDAY + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() + weekday);
  return day.toISOString().slice(0, 10);
}

function matchesOffer(refused: SlotWords, offer: Appointment) {
  if (refused.weekday >= 0 && referenceDate(refused.weekday) !== offer.slot.date) return false;
  if (!refused.hours.length) return true;
  const [hour, minute] = offer.slot.time.split(":").map(Number);
  return refused.hours.length === 1 && refused.hours[0] === (hour % 12 || 12)
    && minute === 0 && (!refused.period || refused.period === (hour < 12 ? "am" : "pm"));
}

export type Draft = {
  turn_id: string; eventId: string; revision: number; raw: string; text: string;
  intent: Decision["intent"]; offerId?: string; date: string; time: string;
  hours: number[]; hour: number | null; period: Period;
};

export function candidate(raw: string, offer?: Appointment): Draft {
  const draft: Draft = {
    turn_id: crypto.randomUUID(), eventId: crypto.randomUUID(), revision: 1, raw, text: raw,
    intent: "message", offerId: offer?.offer_id, date: "", time: "", hours: [], hour: null, period: "",
  };
  if (offer?.status !== "open") return draft;
  const words = raw.normalize("NFC").toLowerCase()
    .replace(/[०-९]/g, char => String(char.charCodeAt(0) - 2406))
    .replace(/[।.,!?]+/g, " ").trim().split(/\s+/u);
  const negative = words.findIndex(word => ["नहीं", "नही", "nahi", "nahin"].includes(word));
  if (negative < 0) return draft;
  if (negative > 0) {
    const refused = parseSlot(words.slice(0, negative));
    if (!refused || !matchesOffer(refused, offer)) return draft;
  }
  if (negative === words.length - 1) {
    return raw.includes("?") ? draft : { ...draft, intent: "decline" };
  }

  const request = words.slice(negative + 1).join(" ")
    .replace(/ (?:मिल सकता है|मिलेगा|mil sakta hai|milega)$/u, "");
  const proposed = parseSlot(request.split(" "));
  if (!proposed) return draft;
  const { weekday, hours, period } = proposed;
  const hour = hours.length === 1 ? hours[0] : null;
  const date = referenceDate(weekday);
  return { ...draft, intent: "counter", hours, hour, period, date, time: hour ? timeOf(hour, period) : "" };
}

// The read-back, caption and wire payload all consume this one revision.
export function reviewDecision(draft: Draft, current: Appointment | null): Decision | null {
  const { turn_id, revision, intent } = draft;
  if (intent === "message") {
    const text = draft.text.trim();
    return text && [...text].length <= 600 ? { turn_id, revision, intent, approved_text: text } : null;
  }
  if (!current || current.offer_id !== draft.offerId || current.status !== "open") return null;
  const offer = speakSlot(current.slot);
  const base = { turn_id, revision, intent, offer_id: current.offer_id };
  if (intent === "accept") return { ...base, approved_text: `हाँ, ${offer} मेरे लिए ठीक है।` };
  const refusal = `नहीं, ${offer} मेरे लिए ठीक नहीं है।`;
  if (intent === "decline") return { ...base, approved_text: refusal };
  if (!draft.date || !draft.time) return null;
  const requested_slot = slot(draft.date, draft.time);
  return { ...base, requested_slot, approved_text: `${refusal} क्या ${speakSlot(requested_slot)} मिल सकता है?` };
}

// A follow-up can resolve only the field currently being asked about.
export function clarifyTime(draft: Draft, answer: string): Partial<Draft> | null {
  const word = answer.normalize("NFC").trim().toLowerCase().replace(/[।.!?]+$/u, "").trim()
    .replace(/[०-९]/g, digit => String(digit.charCodeAt(0) - 2406));
  if (draft.intent !== "counter" || draft.time) return null;
  if (draft.hours.length > 1 && !draft.hour) {
    const hour = hourOf(word.replace(/\s+(?:बजे|baje)$/u, ""));
    return hour !== null && draft.hours.includes(hour) ? { hour, time: timeOf(hour, draft.period) } : null;
  }
  if (draft.hour && !draft.period) {
    const period = periodOf(word);
    return period ? { period, time: timeOf(draft.hour, period) } : null;
  }
  return null;
}
