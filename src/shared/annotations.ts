import type { Annotation, ElementInfo, Geometry, ShapeKind } from "./types";

export interface Pt {
  x: number;
  y: number;
}

/** Preset colours for the next shape. Red is the default; the last choice is remembered. */
export const SWATCHES = [
  { name: "red", hex: "#ff2d55" },
  { name: "yellow", hex: "#facc15" },
  { name: "green", hex: "#22c55e" },
  { name: "cyan", hex: "#06b6d4" },
  { name: "magenta", hex: "#d946ef" },
  { name: "white", hex: "#ffffff" },
  { name: "black", hex: "#111111" },
] as const;

export type SwatchName = (typeof SWATCHES)[number]["name"];
export const DEFAULT_COLOR: SwatchName = "red";
/** chrome.storage.local key of the last colour chosen in the editor. */
export const COLOR_KEY = "annotateColor";

export function swatch(name: string | undefined): (typeof SWATCHES)[number] {
  return SWATCHES.find((s) => s.name === name) ?? SWATCHES[0];
}

/** A shape as drawn in the editor, in image pixels. */
export interface DrawnShape {
  tool: ShapeKind;
  points: Pt[];
  color: SwatchName;
  note: string;
  element?: ElementInfo;
}

const r = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A stroke shorter than this (image px) is a stray click, not a shape. */
export function isShape(tool: ShapeKind, points: Pt[], min = 4): boolean {
  if (points.length < 2) return false;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  if (tool !== "pen") return Math.hypot(b.x - a.x, b.y - a.y) > min;
  return points.some((p) => Math.hypot(p.x - a.x, p.y - a.y) > min);
}

/** At most `max` points, evenly picked, first and last kept. */
export function simplify(points: Pt[], max = 64): Pt[] {
  if (points.length <= max) return points;
  const out: Pt[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  return out;
}

function bboxOf(points: Pt[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Image-pixel geometry of a shape: a box as x/y/width/height, an arrow as from → to (the tip), a pen stroke as points. */
export function imageGeometry(tool: ShapeKind, points: Pt[]): Geometry {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  if (tool === "box") {
    const bb = bboxOf([a, b]);
    return { x: r(bb.x), y: r(bb.y), width: r(bb.width), height: r(bb.height) };
  }
  if (tool === "arrow") return { from: { x: r(a.x), y: r(a.y) }, to: { x: r(b.x), y: r(b.y) } };
  const pts = simplify(points);
  const bb = bboxOf(pts);
  return { points: pts.map((p) => [r(p.x), r(p.y)] as [number, number]), bbox: { x: r(bb.x), y: r(bb.y), width: r(bb.width), height: r(bb.height) } };
}

/** The same geometry scaled by `k` (image px → page CSS px: k = viewport.width / imageWidth), to 0.1 px. */
export function scaleGeometry(g: Geometry, k: number): Geometry {
  if ("from" in g) return { from: { x: r1(g.from.x * k), y: r1(g.from.y * k) }, to: { x: r1(g.to.x * k), y: r1(g.to.y * k) } };
  if ("points" in g) {
    return {
      points: g.points.map(([x, y]) => [r1(x * k), r1(y * k)] as [number, number]),
      bbox: { x: r1(g.bbox.x * k), y: r1(g.bbox.y * k), width: r1(g.bbox.width * k), height: r1(g.bbox.height * k) },
    };
  }
  return { x: r1(g.x * k), y: r1(g.y * k), width: r1(g.width * k), height: r1(g.height * k) };
}

/** Where to look for the element a shape points at (image px): a box's centre, an arrow's tip. Pen strokes: none. */
export function probePoint(tool: ShapeKind, points: Pt[]): Pt | null {
  if (points.length < 2) return null;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  if (tool === "box") return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (tool === "arrow") return { x: b.x, y: b.y };
  return null;
}

/** Numbered in drawing order (1, 2, 3...), like the badges; deleting a shape renumbers the rest. */
export function toAnnotations(shapes: DrawnShape[], viewportWidth: number, imageWidth: number): Annotation[] {
  const k = imageWidth > 0 && viewportWidth > 0 ? viewportWidth / imageWidth : 1;
  return shapes.map((s, i) => {
    const image = imageGeometry(s.tool, s.points);
    return {
      n: i + 1,
      shape: s.tool,
      color: s.color,
      hex: swatch(s.color).hex,
      geometry: { image, css: scaleGeometry(image, k) },
      note: s.note.trim(),
      ...(s.element && s.tool !== "pen" ? { element: s.element } : {}),
    };
  });
}

/** Centre of the number badge: outside a box's top-left corner, at an arrow's tail, at a stroke's start; kept on the image. */
export function badgeCenter(tool: ShapeKind, points: Pt[], radius: number, width: number, height: number): Pt {
  const a = points[0]!;
  let p: Pt;
  if (tool === "box") {
    const b = points[points.length - 1]!;
    p = { x: Math.min(a.x, b.x) - radius, y: Math.min(a.y, b.y) - radius };
  } else p = { x: a.x - radius * 0.8, y: a.y - radius * 0.8 };
  const clamp = (v: number, max: number) => Math.min(Math.max(v, radius + 1), Math.max(radius + 1, max - radius - 1));
  return { x: clamp(p.x, width), y: clamp(p.y, height) };
}

/** Black on light swatches, white on dark ones. */
export function badgeTextColor(hex: string): "#000000" | "#ffffff" {
  const n = parseInt(hex.replace("#", ""), 16);
  const [R, G, B] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * R + 0.587 * G + 0.114 * B > 125 ? "#000000" : "#ffffff";
}
