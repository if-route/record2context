import { fmtVideoTime } from "../shared/format";
import type { Report } from "../shared/report";
import { buildMarkers, eventLabel, isNetworkError, isXhrOrFetch, MARKER_KINDS, markerKind, nearestRow, shortUrl, timeToPercent } from "../shared/timeline";
import type { Annotation, ConsoleErrorEvent, MarkEvent, NetworkEvent, RecEvent, ScreenshotEvent } from "../shared/types";
import { clear, h, longText, scrollWithin } from "./dom";

/** One line per shape: number, colour, shape, note and the element under it. */
function annotationList(list: Annotation[] | undefined): HTMLElement | null {
  if (!list?.length) return null;
  return h(
    "ol",
    { class: "annotations", "data-testid": "annotations" },
    list.map((a) =>
      h(
        "li",
        {},
        h("span", { class: "swatch", style: `background:${a.hex}` }),
        h("b", {}, `${a.n} `),
        `${a.color} ${a.shape}`,
        a.note ? h("span", { class: "note" }, `: ${a.note}`) : "",
        a.element ? h("small", {}, ` on ${a.element.tag} "${a.element.label}"${a.element.testId ? ` [${a.element.testId}]` : ""}`) : "",
      ),
    ),
  );
}

type Tab = "events" | "network" | "console" | "screenshots";
type NetFilter = "all" | "errors" | "xhr";

interface Rows {
  times: number[];
  els: HTMLElement[];
}

/** Video, marker timeline and the time-synced Events / Network / Console / Screenshots tabs. */
export class Player {
  readonly el: HTMLElement;
  readonly video: HTMLVideoElement;
  private readonly durationMs: number;
  private readonly events: RecEvent[];
  private readonly playhead = h("div", { class: "playhead" });
  private readonly timeLabel = h("span", { class: "time-label" }, "0:00.0");
  private readonly markerEls: { t: number; el: HTMLElement }[] = [];
  private readonly panel = h("div", { class: "panel" });
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = "events";
  private netFilter: NetFilter = "all";
  private follow = true;
  private rows: Rows = { times: [], els: [] };
  private current = -1;
  private currentMarker: HTMLElement | null = null;
  private raf = 0;
  private listeners: ((ms: number) => void)[] = [];

  /** `fileUrl` turns a path inside the session (`<id>.webm`, `screenshots/01.png`) into a URL the page can load ("" if not). */
  constructor(
    report: Report,
    private readonly fileUrl: (file: string) => string,
  ) {
    this.events = report.events as RecEvent[];
    this.durationMs = report.durationMs;
    this.video = h("video", { controls: true, preload: "auto", src: report.video ? fileUrl(report.video.file) : "" });
    this.el = h("div", { class: "player" }, h("div", { class: "video-wrap" }, this.video), this.buildTimeline(), this.buildMarks(), this.buildTabs(), this.panel);

    const tick = () => this.sync();
    this.video.addEventListener("timeupdate", tick);
    this.video.addEventListener("seeked", tick);
    this.video.addEventListener("play", () => {
      const loop = () => {
        this.sync();
        if (!this.video.paused) this.raf = requestAnimationFrame(loop);
      };
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(loop);
    });
    this.renderTab();
  }

  get nowMs(): number {
    return Math.round(this.video.currentTime * 1000);
  }

  onTime(fn: (ms: number) => void) {
    this.listeners.push(fn);
  }

  seek(ms: number) {
    this.video.currentTime = Math.max(0, Math.min(this.durationMs, ms)) / 1000;
    this.sync();
  }

  private buildTimeline(): HTMLElement {
    const track = h("div", { class: "track", title: "Click to seek" });
    track.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).classList.contains("marker")) return;
      const r = track.getBoundingClientRect();
      this.seek(((ev.clientX - r.left) / r.width) * this.durationMs);
    });
    for (const m of buildMarkers(this.events)) {
      const el = h("button", {
        class: `marker k-${m.kind}`,
        style: `left:${timeToPercent(m.t, this.durationMs)}%`,
        title: `${fmtVideoTime(m.t)}  ${m.label}`,
        "data-testid": "timeline-marker",
        onclick: () => this.seek(m.t),
      });
      this.markerEls.push({ t: m.t, el });
      track.append(el);
    }
    track.append(this.playhead);
    const legend = h(
      "div",
      { class: "legend" },
      MARKER_KINDS.map((k) => h("span", {}, h("i", { class: `dot k-${k.kind}` }), k.label)),
      this.timeLabel,
      h("span", { class: "dim" }, ` / ${fmtVideoTime(this.durationMs)}`),
    );
    return h("div", { class: "timeline" }, track, legend);
  }

  /** Each Mark with its whole note and its screenshot; click to seek to it. */
  private buildMarks(): HTMLElement | string {
    const marks = this.events.filter((e): e is MarkEvent => e.type === "mark");
    if (!marks.length) return "";
    return h(
      "div",
      { class: "marks" },
      marks.map((m) => {
        const img = this.fileUrl(m.annotatedScreenshot ?? m.screenshot ?? "");
        return h(
          "button",
          { class: "mark-note", "data-testid": "mark-note", title: "Seek video here", onclick: () => this.seek(m.t) },
          h("span", { class: "t" }, `Screenshot ${m.n} · ${fmtVideoTime(m.t)}`),
          h("span", { class: m.note ? "note" : "note dim" }, m.note || "(no note)"),
          img ? h("img", { class: "mark-thumb", src: img, alt: m.screenshot ?? "", "data-testid": "mark-thumb" }) : "",
        );
      }),
    );
  }

  private buildTabs(): HTMLElement {
    const count = (f: (e: RecEvent) => boolean) => this.events.filter(f).length;
    const tabs: [Tab, string, number][] = [
      ["events", "Events", count((e) => e.type !== "network" && e.type !== "console_error")],
      ["network", "Network", count((e) => e.type === "network")],
      ["console", "Console", count((e) => e.type === "console_error")],
      ["screenshots", "Screenshots", count((e) => e.type === "screenshot")],
    ];
    const bar = h("div", { class: "tabs", role: "tablist" });
    for (const [tab, label, n] of tabs) {
      const b = h("button", { role: "tab", "data-tab": tab, onclick: () => this.setTab(tab) }, label, h("span", { class: "badge" }, n));
      this.tabButtons.set(tab, b);
      bar.append(b);
    }
    const follow = h("input", { type: "checkbox", checked: true, onchange: (e: Event) => (this.follow = (e.target as HTMLInputElement).checked) });
    bar.append(h("label", { class: "follow" }, follow, " Follow playback"));
    return bar;
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    this.renderTab();
  }

  private row(t: number, cls: string, ...cells: (Node | string)[]): HTMLElement {
    return h("div", { class: `row ${cls}`, onclick: () => this.seek(t), title: "Seek video here" }, h("span", { class: "t" }, fmtVideoTime(t)), ...cells);
  }

  private renderTab() {
    for (const [t, b] of this.tabButtons) b.classList.toggle("active", t === this.tab);
    clear(this.panel);
    this.current = -1;
    let list: { t: number; el: HTMLElement }[] = [];

    if (this.tab === "events") {
      list = this.events
        .filter((e) => e.type !== "network" && e.type !== "console_error")
        .map((e) => {
          const detail =
            e.type === "click"
              ? [e.testId ? `testId ${e.testId}` : "", e.href ?? "", e.selector].filter(Boolean).join(" · ")
              : e.type === "page_load"
                ? e.title
                : e.type === "mark" && e.note.includes("\n")
                  ? e.note
                  : "";
          return {
            t: e.t,
            el: this.row(e.t, `k-${markerKind(e) ?? "other"}`, h("span", { class: "type" }, e.type), h("span", { class: "main" }, longText(eventLabel(e), 140), detail ? h("small", {}, longText(detail, 120)) : null)),
          };
        });
    } else if (this.tab === "network") {
      const filters: [NetFilter, string][] = [
        ["all", "All"],
        ["errors", "Errors"],
        ["xhr", "XHR / fetch"],
      ];
      this.panel.append(
        h(
          "div",
          { class: "filters" },
          filters.map(([f, label]) => h("button", { class: f === this.netFilter ? "active" : "", "data-filter": f, onclick: () => ((this.netFilter = f), this.renderTab()) }, label)),
        ),
      );
      const net = this.events.filter((e): e is NetworkEvent => e.type === "network");
      list = net
        .filter((e) => (this.netFilter === "errors" ? isNetworkError(e) : this.netFilter === "xhr" ? isXhrOrFetch(e) : true))
        .map((e) => ({
          t: e.t,
          el: this.row(
            e.t,
            isNetworkError(e) ? "err" : "",
            h("span", { class: "method" }, e.method || "—"),
            h("span", { class: `status ${isNetworkError(e) ? "bad" : ""}` }, e.status || "0"),
            h("span", { class: "main" }, longText(e.url, 90, shortUrl(e.url, 1000))),
            h("span", { class: "dur" }, `${e.durationMs} ms`),
            h("span", { class: "src" }, e.source),
          ),
        }));
    } else if (this.tab === "console") {
      list = this.events
        .filter((e): e is ConsoleErrorEvent => e.type === "console_error")
        .map((e) => ({ t: e.t, el: this.row(e.t, "err", h("span", { class: "type" }, e.source), h("span", { class: "main" }, e.message, e.stack ? h("pre", {}, e.stack) : null)) }));
    } else {
      list = this.events
        .filter((e): e is ScreenshotEvent => e.type === "screenshot")
        .map((e) => ({
          t: e.t,
          el: h(
            "figure",
            { class: "shot row", onclick: () => this.seek(e.t), title: "Seek video here" },
            h("img", { src: this.fileUrl(e.annotatedFile ?? e.file), alt: e.file, loading: "lazy" }),
            h("figcaption", {}, h("span", { class: "t" }, fmtVideoTime(e.t)), ` ${e.file}${e.mark ? ` · Screenshot ${e.mark}` : ""}${e.annotated ? " (annotated)" : ""}`, annotationList(e.annotations)),
          ),
        }));
    }

    const box = h("div", { class: `list list-${this.tab}` });
    if (list.length === 0) box.append(h("p", { class: "empty" }, "Nothing recorded."));
    for (const r of list) box.append(r.el);
    this.panel.append(box);
    this.rows = { times: list.map((r) => r.t), els: list.map((r) => r.el) };
    this.sync(true);
  }

  private sync(force = false) {
    const ms = this.nowMs;
    this.playhead.style.left = `${timeToPercent(ms, this.durationMs)}%`;
    this.timeLabel.textContent = fmtVideoTime(ms);

    const mi = nearestRow(
      this.markerEls.map((m) => m.t),
      ms,
    );
    const marker = this.markerEls[mi]?.el ?? null;
    if (marker !== this.currentMarker) {
      this.currentMarker?.classList.remove("current");
      marker?.classList.add("current");
      this.currentMarker = marker;
    }

    const i = nearestRow(this.rows.times, ms);
    if (i !== this.current || force) {
      this.rows.els[this.current]?.classList.remove("current");
      this.current = i;
      const el = this.rows.els[i];
      if (el) {
        el.classList.add("current");
        const box = el.parentElement;
        if (this.follow && box) scrollWithin(box, el);
      }
    }
    for (const fn of this.listeners) fn(ms);
  }
}
