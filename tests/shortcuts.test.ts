import { describe, expect, it } from "vitest";
import manifest from "../static/manifest.json";
import { COMMANDS, NO_KEY, formatKey, shortcutKeys, shortcutLines } from "../src/shared/shortcuts";

describe("shortcuts", () => {
  it("lists every manifest command, and only those", () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(Object.keys(manifest.commands).sort());
  });

  it("suggests at most 4 keys (Chrome's limit) and Alt+Shift+S for Screenshot", () => {
    const keys = Object.values(manifest.commands).map((c) => c.suggested_key.default);
    expect(keys.length).toBeLessThanOrEqual(4);
    expect(new Set(keys).size).toBe(keys.length);
    expect(manifest.commands.screenshot.suggested_key.default).toBe("Alt+Shift+S");
  });

  it("shows Mac symbols in ⌃⌥⇧⌘ order on macOS, Chrome's text elsewhere", () => {
    expect(formatKey("Alt+Shift+S", true)).toBe("⌥⇧S");
    expect(formatKey("Shift+Alt+M", true)).toBe("⌥⇧M");
    expect(formatKey("Ctrl+Shift+Y", true)).toBe("⇧⌘Y");
    expect(formatKey("MacCtrl+Alt+K", true)).toBe("⌃⌥K");
    expect(formatKey("⌥⇧R", true)).toBe("⌥⇧R");
    expect(formatKey("Alt+Shift+S", false)).toBe("Alt+Shift+S");
    expect(formatKey("", true)).toBe("");
    expect(formatKey(undefined, false)).toBe("");
  });

  it("says where to set a cleared key", () => {
    const keys = shortcutKeys([{ name: "toggle-recording", shortcut: "Alt+Shift+R" }, { name: "screenshot", shortcut: "" }, { name: "_execute_action" }], true);
    expect(keys).toEqual([
      { name: "toggle-recording", key: "⌥⇧R" },
      { name: "screenshot", key: "" },
    ]);
    expect(shortcutLines(keys).map((l) => l.key)).toEqual(["⌥⇧R", NO_KEY]);
  });
});
