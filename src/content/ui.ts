import { COMMANDS, NO_KEY, type ShortcutKey } from "../shared/shortcuts";
import { elapsedMs, isPaused, type VideoClock } from "../shared/clock";

/** Ripple/cursor colours are fixed so a frame check can find them in the video. */
export const RIPPLE_COLOR = "#ff2d55";
export const CURSOR_COLOR = "#ffc400";
/** Shown only while the recorder is paused; the E2E checks no frame of the video contains it. */
export const COUNTDOWN_COLOR = "#2563eb";

const CSS = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.cursor { position: fixed; left: 0; top: 0; width: 12px; height: 12px; margin: -8px 0 0 -8px;
  border-radius: 50%; background: ${CURSOR_COLOR}; border: 2px solid #111; opacity: .9;
  transform: translate(-200px, -200px); will-change: transform; }
.ripple { position: fixed; width: 34px; height: 34px; margin: -21px 0 0 -21px; border: 4px solid ${RIPPLE_COLOR};
  border-radius: 50%; box-shadow: 0 0 0 2px rgba(255,255,255,.85); animation: r2c-rip .7s ease-out forwards; }
@keyframes r2c-rip { from { transform: scale(.6); opacity: 1; } 70% { opacity: .9; } to { transform: scale(1.5); opacity: 0; } }
/* Above any page overlay: the timer must stay visible, its digit changes are how the recorder measures video lag. */
.hud { position: fixed; z-index: 2147483647; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: auto;
  display: flex; gap: 6px; align-items: center; padding: 6px 6px 6px 12px; border-radius: 999px;
  background: #111827; color: #f9fafb; font: 600 13px/1 -apple-system, system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); user-select: none; }
.hud.dragged { transform: none; }
.rec { display: flex; align-items: center; gap: 6px; cursor: grab; font-variant-numeric: tabular-nums; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; }
.dot.dim { opacity: .25; }
/* Changes every beat in two shades too close to see, so every 250 ms is a lag sample for the recorder (raw frames tell). */
.beacon { width: 3px; height: 3px; background: #111827; }
.beacon.alt { background: #161d2e; }
button { all: unset; cursor: pointer; padding: 7px 12px; border-radius: 999px; background: #374151; color: #fff;
  font: 600 12px/1 -apple-system, system-ui, sans-serif; }
button:hover { background: #4b5563; }
button.mark { background: #d97706; }
button.mark:hover { background: #b45309; }
button.stop { background: #dc2626; }
button.stop:hover { background: #b91c1c; }
button:disabled { opacity: .5; cursor: default; }
button kbd { margin-left: 5px; font: 500 11px/1 -apple-system, system-ui, sans-serif; opacity: .7; }
.hud.paused .dot { background: #f59e0b; opacity: 1; }
/* One fixed-width slot for "Paused" and the countdown, so the HUD never changes width and the timer never moves. */
.slot { display: inline-grid; width: 58px; justify-items: center; align-items: center; }
.slot > * { grid-area: 1 / 1; }
.off { visibility: hidden; }
.state { color: #fbbf24; font-weight: 600; }
.countdown { box-sizing: border-box; width: 40px; height: 24px; padding: 3px 0 0; border-radius: 12px; background: ${COUNTDOWN_COLOR};
  color: #fff; text-align: center; font: 700 14px/1 -apple-system, system-ui, sans-serif; font-variant-numeric: tabular-nums; overflow: hidden; }
.countdown .bar { display: block; height: 3px; margin: 3px auto 0; width: 28px; background: rgba(255,255,255,.85); border-radius: 2px; }
.note { position: fixed; z-index: 2147483647; left: 50%; bottom: 64px; transform: translateX(-50%); pointer-events: auto; width: min(560px, calc(100vw - 32px));
  box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px;
  background: #111827; color: #f9fafb; box-shadow: 0 6px 24px rgba(0,0,0,.4); font: 500 12px/1.4 -apple-system, system-ui, sans-serif; }
.note textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 72px; max-height: 40vh; overflow: auto;
  padding: 8px 10px; border-radius: 8px; background: #1f2937; color: #f9fafb; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 400 14px/1.45 -apple-system, system-ui, "Sukhumvit Set", "Noto Sans Thai", sans-serif; resize: vertical; cursor: text; }
.note .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.note .hint { color: #9ca3af; }
.note button.go { background: #16a34a; }
.note button.go:hover { background: #15803d; }
.toast { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); pointer-events: none;
  background: #111827; color: #fff; padding: 8px 12px; border-radius: 8px; font: 500 12px/1.3 system-ui, sans-serif; }
.hidden { display: none !important; }
`;

export interface UiCallbacks {
  onStop(): void;
  onMark(): void;
  onContinue(note: string): void;
  onNoteInput(note: string): void;
  /** HUD pixels at `rect` changed at `at`, drawn in this frame; lets the recorder measure how far the video trails the page. */
  onTick?(at: number, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }): void;
}

export class RecorderUI {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  private cursor: HTMLElement;
  private layer: HTMLElement;
  private hud: HTMLElement;
  private timer: HTMLElement;
  private markBtn: HTMLButtonElement;
  private stateEl: HTMLElement;
  private countdownEl: HTMLElement;
  private note: HTMLElement;
  private noteText: HTMLTextAreaElement;
  private continueBtn: HTMLButtonElement;
  private interval = 0;
  private raf = 0;
  private tickPending = false;
  private unmounted = false;
  private beat = 0;
  private dot!: HTMLElement;
  private beacon!: HTMLElement;
  private rec!: HTMLElement;
  private mouse = { x: -200, y: -200 };
  private cleanup: (() => void)[] = [];

  constructor(private clock: VideoClock, private cb: UiCallbacks, keys: readonly ShortcutKey[] = []) {
    this.host = document.createElement("record2context-ui");
    this.host.setAttribute("data-record2context", "");
    // Open (not closed) so E2E locators can reach the HUD; events are still filtered by composedPath.
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="layer"><div class="cursor"></div></div>
      <div class="hud" role="toolbar" aria-label="record2context">
        <span class="rec" title="Drag to move"><span class="beacon"></span><span class="dot"></span><span class="time">00:00</span></span>
        <span class="slot"><span class="state off">Paused</span><span class="countdown off" role="status" aria-label="Continuing in"><span class="n"></span><span class="bar"></span></span></span>
        <button class="mark" type="button" title="Pause, capture the page, draw and write a note">Screenshot</button>
        <button class="stop" type="button" title="Stop and save">Stop</button>
      </div>
      <div class="note hidden" role="dialog" aria-label="Screenshot note">
        <textarea class="note-text" rows="3" placeholder="Note for this moment (optional)" aria-label="Note"></textarea>
        <div class="row"><span class="hint">Video paused · Enter = Continue · Shift+Enter = new line</span>
          <button class="go" type="button">Continue</button></div>
      </div>`;
    this.layer = this.root.querySelector(".layer")!;
    this.cursor = this.root.querySelector(".cursor")!;
    this.hud = this.root.querySelector(".hud")!;
    this.timer = this.root.querySelector(".time")!;
    this.dot = this.root.querySelector(".dot")!;
    this.beacon = this.root.querySelector(".beacon")!;
    this.rec = this.root.querySelector(".rec")!;
    this.markBtn = this.root.querySelector(".mark")!;
    this.stateEl = this.root.querySelector(".state")!;
    this.countdownEl = this.root.querySelector(".countdown")!;
    this.note = this.root.querySelector(".note")!;
    this.noteText = this.root.querySelector(".note-text")!;
    this.continueBtn = this.root.querySelector(".go")!;
    const stopBtn = this.root.querySelector<HTMLButtonElement>(".stop")!;
    this.showKeys(keys);

    // Keep HUD presses from stealing focus or closing the page's open menus; the page never sees the note typing.
    const guarded = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut"];
    for (const el of [this.hud, this.note]) {
      for (const type of guarded) {
        el.addEventListener(type, (e) => {
          e.stopPropagation();
          if ((type === "pointerdown" || type === "mousedown") && e.target !== this.noteText) e.preventDefault();
        });
      }
    }
    this.markBtn.addEventListener("click", () => cb.onMark());
    this.continueBtn.addEventListener("click", () => cb.onContinue(this.noteText.value));
    this.noteText.addEventListener("input", () => cb.onNoteInput(this.noteText.value));
    this.noteText.addEventListener("keydown", (e) => {
      // 229 / isComposing: Enter that confirms an IME candidate (Thai, Japanese, ...) is not "Continue".
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      cb.onContinue(this.noteText.value);
    });
    stopBtn.addEventListener("click", () => {
      stopBtn.disabled = true;
      stopBtn.textContent = "Saving…";
      cb.onStop();
    });
    this.enableDrag(this.root.querySelector(".rec")!);
  }

  mount(): void {
    (document.documentElement ?? document).appendChild(this.host);
    const move = (e: MouseEvent) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (!this.raf) this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.cursor.style.transform = `translate(${this.mouse.x}px, ${this.mouse.y}px)`;
      });
    };
    // Presses inside the screenshot editor are not page clicks: no ripple.
    const down = (e: PointerEvent) => {
      if (!e.composedPath().some((n) => n instanceof HTMLElement && n.classList.contains("ed"))) this.ripple(e.clientX, e.clientY);
    };
    const leave = (e: MouseEvent) => {
      if (!e.relatedTarget) this.cursor.style.transform = "translate(-200px, -200px)";
    };
    window.addEventListener("mousemove", move, { capture: true, passive: true });
    window.addEventListener("pointerdown", down, { capture: true, passive: true });
    document.addEventListener("mouseout", leave, { capture: true, passive: true });
    this.cleanup.push(
      () => window.removeEventListener("mousemove", move, { capture: true }),
      () => window.removeEventListener("pointerdown", down, { capture: true }),
      () => document.removeEventListener("mouseout", leave, { capture: true }),
    );
    this.tick();
    // In a frame callback, so the time reported with a change is the frame that draws it.
    this.interval = window.setInterval(() => requestAnimationFrame(() => this.tick()), 250);
  }

  unmount(): void {
    // A frame callback the interval already queued must not put the host back.
    this.unmounted = true;
    clearInterval(this.interval);
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.host.remove();
  }

  isOwnEvent(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  /** Hide everything so captureVisibleTab gets the page only. */
  setCaptureHidden(hidden: boolean): void {
    this.host.style.setProperty("visibility", hidden ? "hidden" : "visible", "important");
  }

  setHudVisible(visible: boolean): void {
    this.hud.classList.toggle("hidden", !visible);
  }

  /** Each button shows its shortcut as Chrome has it; a cleared one shows none here (the popup says so) and in the tooltip. */
  private showKeys(keys: readonly ShortcutKey[]): void {
    for (const { name, hud } of COMMANDS) {
      const btn = this.root.querySelector<HTMLButtonElement>(`button.${hud}`)!;
      const key = keys.find((k) => k.name === name)?.key ?? "";
      btn.title += ` (${key || NO_KEY})`;
      if (!key) continue;
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      btn.append(kbd);
    }
  }

  setClock(clock: VideoClock): void {
    this.clock = clock;
    this.tick();
  }

  /** Paused: the note box shows (with `draft`) unless the Mark editor takes the note, the timer freezes, the Screenshot button is off. */
  setPaused(paused: boolean, draft = "", noteBox = true): void {
    this.countdownEl.classList.add("off");
    this.hud.classList.toggle("paused", paused);
    this.stateEl.classList.toggle("off", !paused);
    this.note.classList.toggle("hidden", !paused || !noteBox);
    this.continueBtn.disabled = false;
    if (paused && !noteBox) this.noteText.value = draft;
    else if (paused) {
      this.noteText.value = draft;
      this.noteText.focus({ preventScroll: true });
    } else {
      this.noteText.value = "";
      this.noteText.blur();
    }
    this.syncButtons();
  }

  /** Hide the note box before the recorder resumes, so it never shows in the video. */
  hideNote(): void {
    this.continueBtn.disabled = true;
    this.note.classList.add("hidden");
  }

  /**
   * Countdown before the recorder resumes: `n` seconds and `part` quarters of the bar left, or null to end it with the HUD
   * already looking "recording". Each step is also a lag sample, taken right before the resume it precedes.
   */
  setCountdown(step: { n: number; part: number } | null): void {
    this.stateEl.classList.add("off");
    if (!step) {
      this.countdownEl.classList.add("off");
      this.hud.classList.remove("paused");
      return;
    }
    this.drawTick(this.countdownEl, () => {
      this.countdownEl.querySelector<HTMLElement>(".n")!.textContent = String(step.n);
      this.countdownEl.querySelector<HTMLElement>(".bar")!.style.width = `${step.part * 7}px`;
      this.countdownEl.classList.remove("off");
    });
  }

  get noteValue(): string {
    return this.noteText.value;
  }

  private syncButtons(): void {
    const paused = isPaused(this.clock);
    this.markBtn.disabled = paused;
  }

  toast(text: string, ms = 2500): void {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  private ripple(x: number, y: number): void {
    const r = document.createElement("div");
    r.className = "ripple";
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    this.layer.appendChild(r);
    setTimeout(() => r.remove(), 800);
  }

  /** Every 250 ms (one beat): the beacon flips, the dot blinks every other beat, the timer follows the clock; drawn as one lag tick. */
  private tick(): void {
    if (this.unmounted) return;
    // Page scripts occasionally wipe <html> children; put the overlay back.
    if (!this.host.isConnected) (document.documentElement ?? document).appendChild(this.host);
    const s = Math.floor(elapsedMs(this.clock) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    const text = s >= 3600 ? `${Math.floor(s / 3600)}:${mm.slice(-2)}:${ss}` : `${mm}:${ss}`;
    const paused = isPaused(this.clock);
    const beat = this.beat++;
    const dim = !paused && beat % 4 >= 2;
    if (this.tickPending) return;
    this.tickPending = true;
    this.drawTick(this.rec, () => {
      this.tickPending = false;
      this.timer.textContent = text;
      this.dot.classList.toggle("dim", dim);
      this.beacon.classList.toggle("alt", beat % 2 === 1);
    });
  }

  /**
   * Change `el` (via `apply`) in a frame callback 0-2 frames from now at random, and report when and where: capture keeps
   * every other 60 Hz frame, and a steady phase would bias every lag sample by one frame.
   */
  private drawTick(el: HTMLElement, apply: () => void): void {
    let wait = Math.floor(Math.random() * 3);
    const draw = () => {
      if (this.unmounted) return;
      if (wait-- > 0) return void requestAnimationFrame(draw);
      const at = Date.now();
      apply();
      const visible = !this.hud.classList.contains("hidden") && this.host.style.visibility !== "hidden";
      if (!visible || !this.cb.onTick) return;
      const r = el.getBoundingClientRect();
      this.cb.onTick(at, { x: r.x, y: r.y, width: r.width, height: r.height }, { width: innerWidth, height: innerHeight });
    };
    requestAnimationFrame(draw);
  }

  private enableDrag(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      const rect = this.hud.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.hud.classList.add("dragged");
        this.hud.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, ev.clientX - dx))}px`;
        this.hud.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, ev.clientY - dy))}px`;
        this.hud.style.bottom = "auto";
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
}

/** Resolve after the browser has painted the current DOM state. */
export function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
}
