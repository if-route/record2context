export const SCHEMA_VERSION = 5;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

/** Where an event came from when it was not the top-level document. */
export interface FrameInfo {
  url: string;
  /** True when bbox/point were translated into top-level viewport coordinates. */
  translated: boolean;
}

interface Base {
  /** ms on the video clock: since the first frame, paused time excluded. Never negative. */
  t: number;
  /** location.pathname + search + hash of the page at event time. */
  path: string;
  frame?: FrameInfo;
  /** Happened while the video was paused; `t` is then the pause point. */
  duringPause?: true;
}

export type NavigationKind = "navigate" | "reload" | "back_forward" | "prerender" | "unknown";

export interface PageLoadEvent extends Base {
  type: "page_load";
  navigationType: NavigationKind;
  /** True for the page that was already open when recording started. */
  initial: boolean;
  url: string;
  title: string;
}

export interface RouteChangeEvent extends Base {
  type: "route_change";
  from: string;
  to: string;
  via: "pushState" | "replaceState" | "popstate" | "hashchange";
}

export type LabelSource =
  | "innerText"
  | "value"
  | "aria-label"
  | "aria-labelledby"
  | "title"
  | "alt"
  | "placeholder"
  | "data-testid"
  | "label"
  | "heading"
  | "class"
  | "tag";

export interface ClickEvent extends Base {
  type: "click";
  label: string;
  labelSource: LabelSource;
  tag: string;
  role?: string;
  testId?: string;
  selector: string;
  /** Element box in CSS px, relative to the top-level viewport (see frame). */
  bbox: Rect;
  /** Pointer position in CSS px, relative to the top-level viewport. */
  point: { x: number; y: number };
  viewport: ViewportInfo;
  href?: string;
}

export interface InputEvent extends Base {
  type: "input";
  selector: string;
  label: string;
  tag: string;
  inputType: string;
  value: string;
  valueLength: number;
  masked: boolean;
  truncated: boolean;
}

export interface KeyEvent extends Base {
  type: "key";
  key: "Enter" | "Escape" | "Tab";
  modifiers: string[];
  selector: string;
  label: string;
  tag: string;
}

export interface NetworkEvent extends Base {
  type: "network";
  method: string;
  url: string;
  /** 0 = network error or status hidden by the browser (resource-timing). */
  status: number;
  durationMs: number;
  source: "fetch" | "xhr" | "resource-timing";
  error?: string;
  /** Its request/response bodies are in `details/private-do-not-share/bodies/<bodyId>.json` (only set when that file was written). */
  bodyId?: string;
}

export interface ConsoleErrorEvent extends Base {
  type: "console_error";
  source: "console.error" | "window.error" | "unhandledrejection";
  message: string;
  stack?: string;
}

/** The element under a box's centre or an arrow's tip on the live page when the shape was drawn. */
export interface ElementInfo {
  tag: string;
  label: string;
  labelSource: LabelSource;
  selector: string;
  testId?: string;
  role?: string;
  /** Visible text, at most 80 chars. */
  text?: string;
  /** CSS px in the top-level viewport. */
  bbox: Rect;
  /** A few computed styles. `inheritedBackground`: the nearest ancestor's background when the element's own is transparent. */
  style: { color: string; backgroundColor: string; inheritedBackground?: string; fontSize: string; fontWeight: string; display: string; visibility: string };
  /** Inside an iframe: only the iframe element could be seen from the top page. */
  iframe?: true;
}

export type ShapeKind = "box" | "arrow" | "pen";

export type Geometry =
  | { x: number; y: number; width: number; height: number }
  | { from: { x: number; y: number }; to: { x: number; y: number } }
  | { points: [number, number][]; bbox: Rect };

/** One shape drawn on a screenshot, numbered like its badge in the image. */
export interface Annotation {
  /** 1-based: the badge drawn next to the shape. */
  n: number;
  shape: ShapeKind;
  /** Swatch name (`red`, `yellow`, ...); `hex` is the exact colour. */
  color: string;
  hex: string;
  /** `image`: pixels of the PNG. `css`: CSS px of the page viewport at capture (image px * viewport.width / imageWidth). */
  geometry: { image: Geometry; css: Geometry };
  note: string;
  /** Box and arrow only. */
  element?: ElementInfo;
}

export interface ScreenshotEvent extends Base {
  type: "screenshot";
  /** The image as captured; it includes the shapes when any were drawn. */
  file: string;
  viewport: ViewportInfo;
  imageWidth: number;
  imageHeight: number;
  annotated: boolean;
  /** The copy with the shapes and badges drawn on, when anything was drawn. */
  annotatedFile?: string;
  /** Taken for this mark (paused; `t` is the mark's). */
  mark?: number;
  annotations?: Annotation[];
}

/** The tester pressed Screenshot: the video paused here and `note` is what they typed (may be empty). */
export interface MarkEvent extends Base {
  type: "mark";
  /** 1-based, in the order the marks were made. */
  n: number;
  note: string;
  /** The frame at the mark, captured while paused (see the screenshot event with `mark: n`). */
  screenshot?: string;
  annotatedScreenshot?: string;
}

/** The video was paused for `pausedMs` at `t`; that time is not in the video or in any `t`. */
export interface PauseEvent extends Base {
  type: "pause";
  pausedMs: number;
  /** ms added to the logged pause so it equals what the recorder cut (report.clockSync). */
  correctionMs?: number;
}

export type RecEvent =
  | PageLoadEvent
  | RouteChangeEvent
  | ClickEvent
  | InputEvent
  | KeyEvent
  | NetworkEvent
  | ConsoleErrorEvent
  | ScreenshotEvent
  | MarkEvent
  | PauseEvent;

export type RecEventType = RecEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What content scripts send and the log stores: wall-clock `at` (epoch ms); `t` is derived when the report is built. */
export type RawEvent = DistributiveOmit<RecEvent, "t" | "duringPause"> & { at: number };

export interface SessionEnv {
  userAgent: string;
  os: string;
  arch: string;
  viewport: { width: number; height: number };
  dpr: number;
  language?: string;
  languages?: string[];
  /** Intl's resolved locale (number and date formatting). */
  locale?: string;
  timeZone?: string;
  /** Minutes east of UTC at Start (UTC+7 = 420). */
  utcOffsetMinutes?: number;
}

export interface VideoInfo {
  file: string;
  mimeType: string;
  width: number;
  height: number;
  durationMs: number;
  sizeBytes: number;
  /** True when duration/cues were written into the file (seekable). */
  seekableFix: boolean;
  fixError?: string;
}
