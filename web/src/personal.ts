import { api } from "./relay";
import { wav } from "./audio";

const KEY = "svara.personalVoice.v1";
let sessionToken = "";
export function voiceToken() {
  try { return localStorage.getItem(KEY) || sessionToken; }
  catch { return sessionToken; }
}

export function rememberVoice(token: string) {
  sessionToken = token;
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch { /* The current page still has its session token. */ }
}

export function voiceHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function prepareReferences(files: File[]) {
  if (!files.length || files.length > 3) throw new Error("Choose one to three recordings.");
  const rate = 24000;
  const limit = Math.floor(15 * rate / files.length);
  const chunks: Float32Array[] = [];
  for (const file of files) {
    if (file.size > 24 * 1024 * 1024) throw new Error("Choose a clip smaller than 24 MB.");
    const decoder = new OfflineAudioContext(1, 1, rate);
    const audio = await decoder.decodeAudioData(await file.arrayBuffer());
    const mono = new Float32Array(Math.min(limit, audio.length));
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const source = audio.getChannelData(ch);
      for (let i = 0; i < mono.length; i++) mono[i] += source[i] / audio.numberOfChannels;
    }
    chunks.push(mono);
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length < rate * 3) throw new Error("Choose at least three seconds of clear speech.");
  const pcm = new Float32Array(length);
  let start = 0;
  for (const chunk of chunks) { pcm.set(chunk, start); start += chunk.length; }
  return wav(pcm, rate);
}

export async function renderVoice(token: string, text: string, language: "hi" | "en", signal?: AbortSignal) {
  const response = await api("/api/voice/renders", {
    method: "POST", headers: voiceHeaders(token), body: JSON.stringify({ text, language }), signal,
  });
  return (await response.json()).render_id as string;
}
