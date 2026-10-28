import { compactJson, fmtVideoTime } from "./format";
import { isNetworkError } from "./network";
import { maskEmailInput, redactText, redactUrl, scrubEmailsDeep, scrubSecrets } from "./redact";
import type { Report } from "./report";
import type { Annotation, NetworkEvent, RecEvent } from "./types";

export const CONTEXT_VERSION = 1;
/** Fits a GitLab comment (1,000,000) and most AI chat inputs with room to spare. */
export const CONTEXT_MAX_CHARS = 60_000;
export const CONTEXT_SUMMARY = "Context for AI (record2context)";
/** A navigation right after a click or key is that action's result, not a separate step to replay. */
const CAUSED_WITHIN_MS = 3000;

const ACTION_TYPES = new Set<RecEvent["type"]>(["click", "input", "key", "page_load", "route_change"]);

interface Limits {
  /** Max rows per list; Infinity = all. */
  groups: number;
  errors: number;
  perAction: number;
  expect: number;
  console: number;
  actions: number;
  selectors: boolean;
  /** Only the fields needed to tell actions apart; replay keeps how to perform them. */
  lean: boolean;
  text: number;
  note: number;
}

/** Least important parts shrink first: repeated-request groups, then per-action requests, then selectors and text. */
const LEVELS: Limits[] = [
  { groups: Infinity, errors: Infinity, perAction: Infinity, expect: Infinity, console: Infinity, actions: Infinity, selectors: true, lean: false, text: 200, note: Infinity },
  { groups: 200, errors: 200, perAction: 25, expect: 10, console: 100, actions: Infinity, selectors: true, lean: false, text: 200, note: Infinity },
  { groups: 50, errors: 100, perAction: 10, expect: 5, console: 50, actions: Infinity, selectors: false, lean: false, text: 160, note: Infinity },
  { groups: 15, errors: 40, perAction: 3, expect: 3, console: 20, actions: Infinity, selectors: false, lean: false, text: 100, note: 4000 },
  { groups: 5, errors: 20, perAction: 0, expect: 2, console: 10, actions: Infinity, selectors: false, lean: false, text: 80, note: 2000 },
  { groups: 5, errors: 20, perAction: 0, expect: 0, console: 10, actions: Infinity, selectors: false, lean: true, text: 60, note: 2000 },
];

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

function chromeVersion(ua: string): string {
  const v = /Chrome\/(\d+)/.exec(ua)?.[1];
  return v ? `Chrome ${v}` : "Chrome";
}

type Json = Record<string, unknown>;

function build(report: Report, sessionId: string, lim: Limits): { obj: Json; shortened: string[] } {
  const shortened: string[] = [];
  const events = report.events as RecEvent[];
  const frontendHost = hostOf(report.startUrl);
  const text = (s: string, max = lim.text) => clip(redactText(s), max);
  // The tester's own words: only token shapes are removed (as in marks.ts).
  const noteText = (s: string, max = lim.text) => clip(scrubSecrets(s), max);
  // Same host as the start page: path only. Other hosts keep `//host` so the API is still identifiable.
  const url = (u: string) => {
    const safe = scrubSecrets(redactUrl(u));
    try {
      const p = new URL(safe);
      return clip(p.host === frontendHost ? p.pathname + p.search + p.hash : `//${p.host}${p.pathname}${p.search}`, 300);
    } catch {
      return clip(safe, 300);
    }
  };
  const fullUrl = (u: string) => clip(scrubSecrets(redactUrl(u)), 500);
  const limit = <T>(rows: T[], max: number, what: string): T[] => {
    if (rows.length <= max) return rows;
    shortened.push(`${what}: ${max} of ${rows.length} shown`);
    return rows.slice(0, max);
  };

  const network = events.filter((e): e is NetworkEvent => e.type === "network");
  const method = (n: NetworkEvent) => n.method || "?";
  const reqKey = (n: NetworkEvent) => `${method(n)} ${url(n.url)} ${n.status}`;

  // Requests between one action and the next, identical ones counted once.
  const requestsIn = (rows: NetworkEvent[]) => {
    const groups = new Map<string, Json & { count: number; ms: number }>();
    for (const n of rows) {
      const g = groups.get(reqKey(n));
      if (g) {
        g.count++;
        g.ms = Math.max(g.ms, n.durationMs);
      } else {
        groups.set(reqKey(n), {
          t: n.t,
          method: method(n),
          url: url(n.url),
          status: n.status,
          ms: n.durationMs,
          count: 1,
          ...(n.error ? { error: text(n.error) } : {}),
          ...(n.duringPause ? { duringPause: true } : {}),
        });
      }
    }
    return [...groups.values()].map(({ count, ...g }) => (count > 1 ? { ...g, count } : g));
  };
  const expectText = (r: Json) => `${r.method} ${r.url} → ${r.status}${r.count ? ` ×${r.count}` : ""}`;

  const acts = events.filter((e) => ACTION_TYPES.has(e.type));
  const windowEnd = (i: number) => acts[i + 1]?.t ?? Infinity;
  // A request starting exactly at the next action's `t` belongs to the next action.
  const reqOf = acts.map((a, i) => requestsIn(network.filter((n) => n.t >= a.t && n.t < windowEnd(i))));
  const beforeFirst = acts.length ? requestsIn(network.filter((n) => n.t < acts[0]!.t)) : requestsIn(network);

  let perActionCut = 0;
  const actions = acts.map((e, i) => {
    const base: Json = { n: i + 1, t: e.t, ...(lim.lean ? {} : { video: fmtVideoTime(e.t) }), type: e.type, ...(e.duringPause ? { duringPause: true } : {}) };
    let fields: Json = {};
    switch (e.type) {
      case "click":
        fields = {
          label: text(e.label),
          labelSource: e.labelSource,
          tag: e.tag,
          ...(e.role ? { role: e.role } : {}),
          ...(e.testId ? { testId: e.testId } : {}),
          ...(lim.selectors ? { selector: clip(e.selector, 200) } : {}),
          ...(e.href ? { href: url(e.href) } : {}),
          route: url(e.path),
        };
        break;
      case "input":
        fields = {
          label: text(e.label),
          inputType: e.inputType,
          value: e.masked ? "[MASKED]" : text(e.value, 200),
          ...(e.masked || e.truncated ? { valueLength: e.valueLength } : {}),
          ...(e.truncated ? { truncated: true } : {}),
          ...(lim.selectors ? { selector: clip(e.selector, 200) } : {}),
          route: url(e.path),
        };
        break;
      case "key":
        fields = { key: [...e.modifiers, e.key].join("+"), label: text(e.label), ...(lim.selectors ? { selector: clip(e.selector, 200) } : {}), route: url(e.path) };
        break;
      case "page_load":
        fields = { navigation: e.initial ? "open at start" : e.navigationType, url: url(e.url), title: text(e.title) };
        break;
      case "route_change":
        fields = { from: url(e.from), to: url(e.to), via: e.via };
        break;
    }
    if (lim.lean) for (const k of ["labelSource", "tag", "role", "route", "title", "href"]) delete fields[k];
    const reqs = reqOf[i]!;
    if (reqs.length > lim.perAction) perActionCut++;
    const shown = reqs.slice(0, lim.perAction);
    return {
      ...base,
      ...fields,
      ...(shown.length ? { requests: shown } : {}),
      ...(reqs.length > shown.length ? { requestsOmitted: reqs.length - shown.length } : {}),
    };
  });
  if (perActionCut) shortened.push(lim.perAction ? `actions[].requests: at most ${lim.perAction} per action (see requestsOmitted)` : "actions[].requests: omitted; replay[].expect and network keep the essentials");
  if (!lim.selectors) shortened.push("selectors: only in replay[]");
  if (lim.lean) shortened.push("actions[]: only n, t, type, label and value/key/url (labelSource, tag, role, route, href, title omitted); replay[]: no label or expect");

  const replay: Json[] = [];
  acts.forEach((e, i) => {
    const prev = acts[i - 1];
    const caused = !!prev && (prev.type === "click" || prev.type === "key" || prev.type === "input") && e.t - prev.t <= CAUSED_WITHIN_MS;
    let step: Json | null = null;
    switch (e.type) {
      case "page_load":
        if (e.initial) step = { t: e.t, do: "goto", url: fullUrl(e.url) };
        else if (e.navigationType === "reload") step = { t: e.t, do: "reload" };
        else step = { t: e.t, do: "navigate", url: fullUrl(e.url), ...(e.navigationType === "back_forward" ? { via: "back_forward" } : {}), ...(caused ? { causedByPrevious: true } : {}) };
        break;
      case "route_change":
        step = { t: e.t, do: "navigate", url: url(e.to), via: e.via, ...(caused && e.via !== "popstate" ? { causedByPrevious: true } : {}) };
        break;
      case "click":
        step = { t: e.t, do: "click", ...(lim.lean ? {} : { label: text(e.label) }), selector: clip(e.selector, 200), ...(e.testId ? { testId: e.testId } : {}), ...(e.role && !lim.lean ? { role: e.role } : {}) };
        break;
      case "input":
        step = { t: e.t, do: "fill", selector: clip(e.selector, 200), ...(lim.lean ? {} : { label: text(e.label) }), inputType: e.inputType, value: e.masked ? "[MASKED]" : text(e.value, 200) };
        break;
      case "key":
        step = { t: e.t, do: "key", key: [...e.modifiers, e.key].join("+"), selector: clip(e.selector, 200) };
        break;
    }
    if (!step) return;
    // A request made while paused was not caused by this action, so a replay should not wait for it.
    const exp = reqOf[i]!.filter((r) => !r.duringPause).slice(0, lim.expect).map(expectText);
    replay.push({ ...step, ...(e.duringPause ? { duringPause: true } : {}), ...(exp.length ? { expect: exp } : {}) });
  });
  if (!replay.length || replay[0]!.do !== "goto") replay.unshift({ t: 0, do: "goto", url: fullUrl(report.startUrl) });
  if (lim.expect > 0 && lim.expect !== Infinity && reqOf.some((r) => r.length > lim.expect)) shortened.push(`replay[].expect: at most ${lim.expect} per step`);

  // All network: errors one by one, everything else as identical-request groups.
  const errors = network.filter(isNetworkError).map((n) => ({
    t: n.t,
    method: method(n),
    url: url(n.url),
    status: n.status,
    ms: n.durationMs,
    source: n.source,
    ...(n.error ? { error: text(n.error) } : {}),
    ...(n.duringPause ? { duringPause: true } : {}),
  }));
  const groupMap = new Map<string, { method: string; url: string; status: number; count: number; firstT: number; lastT: number; via?: string }>();
  for (const n of network) {
    if (isNetworkError(n)) continue;
    const g = groupMap.get(reqKey(n));
    if (g) {
      g.count++;
      g.lastT = n.t;
    } else groupMap.set(reqKey(n), { method: method(n), url: url(n.url), status: n.status, count: 1, firstT: n.t, lastT: n.t, ...(n.source === "resource-timing" ? { via: "resource-timing" } : {}) });
  }
  // When groups must be cut, the most repeated go first: they are what an AI cannot reconstruct from actions.
  let groups = [...groupMap.values()];
  if (groups.length > lim.groups) groups = [...groups].sort((a, b) => b.count - a.count || a.firstT - b.firstT);
  groups = limit(groups, lim.groups, "network.groups (most repeated kept)");

  const apiHosts = [...new Set(network.map((n) => hostOf(n.url)))].filter((h) => h && h !== frontendHost).slice(0, 10);
  const consoleErrors = events.flatMap((e) =>
    e.type === "console_error" ? [{ t: e.t, source: e.source, message: text(e.message.split("\n")[0] ?? "", Math.max(lim.text, 300)), ...(e.duringPause ? { duringPause: true } : {}) }] : [],
  );
  const marks = (report.marks ?? []).map((m) => {
    const note = scrubSecrets(m.note);
    if (note.length > lim.note) shortened.push(`marks[${m.n}].note: first ${lim.note} of ${note.length} chars`);
    return { n: m.n, t: m.t, video: fmtVideoTime(m.t), note: clip(note, lim.note), ...(m.screenshot ? { screenshot: m.screenshot } : {}) };
  });
  // One row per shape: number, colour, note, and what it points at (selector and styles only while selectors fit).
  const shape = (a: Annotation): Json => {
    const g = a.geometry.css;
    const where = "from" in g ? { tip: { x: Math.round(g.to.x), y: Math.round(g.to.y) } } : "points" in g ? {} : { box: [g.x, g.y, g.width, g.height].map(Math.round) };
    const el = a.element;
    return {
      n: a.n,
      shape: a.shape,
      color: a.color,
      ...(a.note ? { note: noteText(a.note, Math.max(lim.text, 300)) } : {}),
      ...(lim.lean ? {} : where),
      ...(el
        ? {
            on: {
              tag: el.tag,
              label: text(el.label),
              ...(el.testId ? { testId: el.testId } : {}),
              ...(el.role ? { role: el.role } : {}),
              ...(el.text && !lim.lean ? { text: text(el.text, 80) } : {}),
              ...(lim.selectors ? { selector: clip(el.selector, 200) } : {}),
              ...(lim.selectors
                ? { style: `color ${el.style.color}; background ${el.style.inheritedBackground ?? el.style.backgroundColor}; ${el.style.fontSize} ${el.style.fontWeight}; ${el.style.display}${el.style.visibility === "visible" ? "" : `; ${el.style.visibility}`}` }
                : {}),
            },
          }
        : {}),
    };
  };
  const screenshots = (report.screenshots ?? []).map((sh) => ({
    file: sh.file,
    t: sh.t,
    ...(sh.mark ? { mark: sh.mark } : {}),
    ...(sh.annotatedFile ? { annotatedFile: sh.annotatedFile } : {}),
    ...(sh.annotations?.length ? { shapes: sh.annotations.map(shape) } : {}),
  }));

  const lang = report.browser as { language?: string; timeZone?: string };
  const obj: Json = {
    contextVersion: CONTEXT_VERSION,
    reportSchemaVersion: report.schemaVersion,
    generator: `${report.generator?.name ?? "record2context"} ${report.generator?.version ?? ""}`.trim(),
    session: sessionId,
    recordedAt: report.startedAt,
    startUrl: fullUrl(report.startUrl),
    environment: { frontendHost, apiHosts },
    client: {
      browser: chromeVersion(report.browser.userAgent),
      os: report.browser.os,
      arch: report.browser.arch,
      viewport: `${report.viewport.width}x${report.viewport.height}`,
      dpr: report.devicePixelRatio,
      ...(lang.language ? { language: lang.language } : {}),
      ...(lang.timeZone ? { timeZone: lang.timeZone } : {}),
    },
    video: {
      file: report.video?.file ?? `${sessionId}.webm`,
      durationMs: report.durationMs,
      duration: fmtVideoTime(report.durationMs),
      ...(report.video ? { size: `${report.video.width}x${report.video.height}` } : { missing: text(report.videoError ?? "no video") }),
      pausedMs: report.pausedMs ?? 0,
    },
    pauses: report.pauses ?? [],
    marks,
    actions: limit(actions, lim.actions, "actions"),
    ...(beforeFirst.length ? { requestsBeforeFirstAction: beforeFirst.slice(0, Math.max(lim.perAction, 5)) } : {}),
    consoleErrors: limit(consoleErrors, lim.console, "consoleErrors"),
    screenshots,
    replay: limit(replay, lim.actions, "replay"),
    network: {
      requests: network.length,
      ...(report.counts?.networkDropped ? { droppedByRecorder: report.counts.networkDropped } : {}),
      errors: limit(errors, lim.errors, "network.errors"),
      groups,
    },
  };
  return { obj, shortened };
}

export function contextHeader(sessionId: string): string {
  return `Browser recording by record2context, generated from its report.json (no AI wrote this). Every \`t\` is ms on the attached video \`${sessionId}.webm\` (0 = first frame, paused time left out). \`marks\` are the person's Screenshots; \`screenshots[].mark\` links an image to its mark.`;
}

function wrap(sessionId: string, json: string): string {
  return [`<details><summary>${CONTEXT_SUMMARY}</summary>`, "", contextHeader(sessionId), "", "```json", json, "```", "", "</details>", ""].join("\n");
}

export interface PortableContext {
  markdown: string;
  /** 0 = nothing shortened. */
  level: number;
  shortened: string[];
}

/** Reports saved before email masking: mask email fields and replace addresses (notes stay as written). */
function maskEmails(report: Report): Report {
  const scrubbed = scrubEmailsDeep(report);
  return { ...scrubbed, events: (scrubbed.events as RecEvent[]).map(maskEmailInput) as Report["events"] };
}

/** Deterministic: the same report always gives the same text. */
export function buildPortableContext(source: Report, sessionId: string, maxChars = CONTEXT_MAX_CHARS): PortableContext {
  const report = maskEmails(source);
  let last: PortableContext | null = null;
  for (let level = 0; level < LEVELS.length; level++) {
    const { obj, shortened } = build(report, sessionId, LEVELS[level]!);
    const markdown = wrap(sessionId, compactJson(shortened.length ? { ...obj, shortened } : obj));
    last = { markdown, level, shortened };
    if (markdown.length <= maxChars) return last;
  }
  // Hundreds of actions: keep the header, marks and network errors, and as many actions as fit.
  const lim = LEVELS[LEVELS.length - 1]!;
  const total = (report.events as RecEvent[]).filter((e) => ACTION_TYPES.has(e.type)).length;
  let keep = total;
  while (keep > 0) {
    keep = Math.floor(keep * 0.8);
    const { obj, shortened } = build(report, sessionId, { ...lim, actions: keep, note: 1000, console: 5, errors: 10 });
    const markdown = wrap(sessionId, compactJson({ ...obj, shortened }));
    last = { markdown, level: LEVELS.length, shortened };
    if (markdown.length <= maxChars) return last;
  }
  return last!;
}
