// localStorage, sessionStorage and cookie names of the recorded page at Start, each Mark and Stop. The raw snapshot goes
// only to the private folder; report.json gets `summarizeSnapshot`: keys and redacted, shortened values.
import { redactStorageValue } from "./redact";

export const MAX_KEYS = 500;
export const MAX_VALUE = 64 * 1024;
export const MAX_SNAPSHOT = 1024 * 1024;
export const PREVIEW = 120;

export interface RawArea {
  /** Keys in storage order; `value` is null once the snapshot's size budget is spent. */
  entries: { key: string; value: string | null; length: number }[];
  keys: number;
  error?: string;
}

export interface RawSnapshot {
  origin: string;
  local: RawArea;
  session: RawArea;
  /** Names only: values are never read. */
  cookieNames: string[];
  cookieError?: string;
}

export interface AreaSummary {
  keys: number;
  entries: { key: string; value?: string; length: number; redacted?: true; truncated?: true }[];
  error?: string;
}

export interface StorageSnapshot {
  n: number;
  label: string;
  /** Wall-clock ms; becomes `t` when the report is built. */
  at: number;
  origin?: string;
  local?: AreaSummary;
  session?: AreaSummary;
  cookieNames?: string[];
  /** The file in the private folder with the unredacted values. */
  privateFile?: string;
  error?: string;
}

/** Runs in the page (chrome.scripting.executeScript), so it must not use anything from outside its own body. */
export function collectPageStorage(maxKeys: number, maxValue: number, maxTotal: number): RawSnapshot {
  let budget = maxTotal;
  const area = (get: () => Storage): RawArea => {
    try {
      const s = get();
      const entries: RawArea["entries"] = [];
      for (let i = 0; i < s.length && entries.length < maxKeys; i++) {
        const key = s.key(i) ?? "";
        const v = s.getItem(key) ?? "";
        const value = budget > 0 ? v.slice(0, Math.min(maxValue, budget)) : null;
        budget -= value?.length ?? 0;
        entries.push({ key, value, length: v.length });
      }
      return { entries, keys: s.length };
    } catch (e) {
      return { entries: [], keys: 0, error: String((e as Error)?.message ?? e) };
    }
  };
  let cookieNames: string[] = [];
  let cookieError: string | undefined;
  try {
    cookieNames = [...new Set(document.cookie.split(";").map((c) => c.split("=")[0]!.trim()).filter(Boolean))];
  } catch (e) {
    cookieError = String((e as Error)?.message ?? e);
  }
  return { origin: location.origin, local: area(() => localStorage), session: area(() => sessionStorage), cookieNames, ...(cookieError ? { cookieError } : {}) };
}

function summarizeArea(a: RawArea): AreaSummary {
  return {
    keys: a.keys,
    entries: a.entries.map((e) => {
      if (e.value === null) return { key: e.key, length: e.length, truncated: true as const };
      // A value cut by the size budget can end inside a key: that last piece is never shown.
      const r = redactStorageValue(e.key, e.value.length < e.length ? e.value.replace(/[A-Za-z0-9+/_=.-]+$/, "") : e.value);
      const cut = r.value.length > PREVIEW;
      return { key: e.key, value: cut ? `${r.value.slice(0, PREVIEW)}…` : r.value, length: e.length, ...(r.redacted ? { redacted: true as const } : {}), ...(cut ? { truncated: true as const } : {}) };
    }),
    ...(a.error ? { error: a.error } : {}),
  };
}

export function summarizeSnapshot(raw: RawSnapshot, base: { n: number; label: string; at: number; privateFile?: string }): StorageSnapshot {
  return { ...base, origin: raw.origin, local: summarizeArea(raw.local), session: summarizeArea(raw.session), cookieNames: raw.cookieNames };
}
