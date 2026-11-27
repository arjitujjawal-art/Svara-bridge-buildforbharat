const KEY = "svara.patient.timing";
export const DEFAULT_WAIT = 3000;

export function readTiming(): number {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const wait = data?.waitMs;
    if (data?.version === 1 && Number.isInteger(wait) && (wait === 0 || wait >= 2500 && wait <= 4000)) {
      return wait;
    }
  } catch {
    // Storage can be unavailable on a shared or private browser.
  }
  return DEFAULT_WAIT;
}

export function saveTiming(wait: number): boolean {
  try {
    if (wait === DEFAULT_WAIT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ version: 1, waitMs: wait }));
    return true;
  } catch {
    return false;
  }
}

export function seconds(wait: number) {
  return (wait / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 }) + " seconds";
}
