export type CommandName = "toggle-recording" | "screenshot";

/** In the order the popup lists them; `hud` is the HUD button that shows the key. */
export const COMMANDS: readonly { name: CommandName; label: string; hud: "stop" | "mark" }[] = [
  { name: "toggle-recording", label: "Start / Stop recording", hud: "stop" },
  { name: "screenshot", label: "Screenshot", hud: "mark" },
];

export const NO_KEY = "no key set (chrome://extensions/shortcuts)";

/** `key` is "" when the person cleared the shortcut or Chrome could not assign it. */
export interface ShortcutKey {
  name: CommandName;
  key: string;
}

const MAC_SYMBOLS: Record<string, string> = { MacCtrl: "⌃", Ctrl: "⌘", Command: "⌘", Alt: "⌥", Option: "⌥", Shift: "⇧" };
const MAC_ORDER = "⌃⌥⇧⌘";

/** Chrome's shortcut text for display: Mac symbols (⌃⌥⇧⌘ order) on macOS, as given elsewhere. */
export function formatKey(shortcut: string | undefined, mac: boolean): string {
  const s = (shortcut ?? "").trim();
  if (!s || !mac || !s.includes("+")) return s;
  const parts = s.split("+");
  const key = parts.pop()!;
  const mods = parts.map((p) => MAC_SYMBOLS[p] ?? p).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return mods.join("") + key;
}

export function shortcutKeys(commands: readonly { name?: string; shortcut?: string }[], mac: boolean): ShortcutKey[] {
  return COMMANDS.map(({ name }) => ({ name, key: formatKey(commands.find((c) => c.name === name)?.shortcut, mac) }));
}

/** One line per command for the popup, e.g. "⌥⇧S  Screenshot". */
export function shortcutLines(keys: readonly ShortcutKey[]): { key: string; label: string }[] {
  return COMMANDS.map(({ name, label }) => ({ key: keys.find((k) => k.name === name)?.key || NO_KEY, label }));
}

/** The current keys, read from Chrome (the person may have changed them at chrome://extensions/shortcuts). */
export async function loadShortcutKeys(): Promise<ShortcutKey[]> {
  const [commands, platform] = await Promise.all([chrome.commands.getAll(), chrome.runtime.getPlatformInfo()]);
  return shortcutKeys(commands, platform.os === "mac");
}
