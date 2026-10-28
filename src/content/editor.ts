// Box/arrow/pen drawing ideas adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat):
// src/draw-mode.ts and src/region-screenshot.ts. Draws on the captured image, not the live page.
import { SWATCHES, badgeCenter, badgeTextColor, isShape, probePoint, swatch, toAnnotations, type DrawnShape, type Pt, type SwatchName } from "../shared/annotations";
import type { Annotation, ElementInfo, ShapeKind } from "../shared/types";

export interface EditedShot {
  /** The image with every shape and its number badge drawn on. */
  dataUrl: string;
  width: number;
  height: number;
  annotated: boolean;
  annotations: Annotation[];
  /** The note for the moment. */
  note: string;
}

export interface EditorOptions {
  dpr: number;
  /** CSS width of the page viewport the image was captured from (image px → CSS px). */
  viewportWidth: number;
  color: SwatchName;
  onColor(color: SwatchName): void;
  /** The element on the live page at a CSS point, or null; called when a box or arrow is finished. */
  elementAt(x: number, y: number): ElementInfo | null;
  note?: string;
  onNoteInput?(note: string): void;
}

const CSS = `
.ed { position: fixed; inset: 0; z-index: 2147483647; pointer-events: auto; display: flex; flex-direction: column;
  background: rgba(17,24,39,.9); color: #f9fafb; font: 600 12px/1.3 -apple-system, system-ui, sans-serif; outline: none; }
.bar { display: flex; gap: 6px; padding: 10px; justify-content: center; align-items: center; flex-wrap: wrap; }
.bar .sep { width: 10px; }
.bar button[aria-pressed="true"] { background: #2563eb; }
.bar button.continue { background: #16a34a; }
.bar .sw { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 2px solid #4b5563; box-sizing: border-box; }
.bar .sw[aria-pressed="true"] { border-color: #fff; box-shadow: 0 0 0 2px #2563eb; }
.body { flex: 1; display: flex; min-height: 0; }
.stage { flex: 1; position: relative; overflow: hidden; }
.stage img, .stage canvas { position: absolute; }
.stage canvas { cursor: crosshair; touch-action: none; }
.side { width: 300px; flex: none; overflow: auto; padding: 8px 12px 12px 0; display: flex; flex-direction: column; gap: 8px; }
.side h3 { margin: 4px 0 0; font-size: 12px; color: #d1d5db; }
.side textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 84px; max-height: 30vh; overflow: auto;
  padding: 8px 10px; border-radius: 8px; background: #1f2937; color: #f9fafb; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 400 14px/1.45 -apple-system, system-ui, "Sukhumvit Set", "Noto Sans Thai", sans-serif; cursor: text; }
.shapes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.shapes li { background: #1f2937; border-radius: 8px; padding: 6px 8px; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 6px; align-items: center; }
.shapes .badge { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; }
.shapes .what { color: #d1d5db; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shapes .del { padding: 2px 7px; background: #374151; }
.shapes input { all: unset; grid-column: 1 / -1; box-sizing: border-box; width: 100%; padding: 5px 8px; border-radius: 6px; background: #111827;
  color: #f9fafb; font: 400 13px/1.3 -apple-system, system-ui, "Noto Sans Thai", sans-serif; cursor: text; }
.empty, .hint { color: #9ca3af; font-weight: 500; margin: 0; }
`;

function drawShape(ctx: CanvasRenderingContext2D, s: { tool: ShapeKind; points: Pt[]; color: string }, width: number): void {
  const p = s.points;
  if (p.length < 2 && s.tool !== "pen") return;
  ctx.strokeStyle = swatch(s.color).hex;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const a = p[0]!;
  const b = p[p.length - 1]!;
  if (s.tool === "box") {
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (s.tool === "arrow") {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(14, width * 5);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    for (const d of [Math.PI / 7, -Math.PI / 7]) {
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - d), b.y - head * Math.sin(ang - d));
    }
  } else {
    ctx.moveTo(a.x, a.y);
    for (const q of p.slice(1)) ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
}

function drawBadge(ctx: CanvasRenderingContext2D, s: DrawnShape, n: number, radius: number): void {
  const { hex } = swatch(s.color);
  const c = badgeCenter(s.tool, s.points, radius, ctx.canvas.width, ctx.canvas.height);
  const text = badgeTextColor(hex);
  ctx.beginPath();
  ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = hex;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, radius / 7);
  ctx.strokeStyle = text === "#000000" ? "#111111" : "#ffffff";
  ctx.stroke();
  ctx.fillStyle = text;
  ctx.font = `700 ${Math.round(radius * 1.15)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), c.x, c.y + radius * 0.06);
}

/** Show the annotate overlay, opened by Screenshot while the video is paused; it resolves on Continue (no Cancel). */
export function openEditor(root: ShadowRoot, src: string, opts: EditorOptions): Promise<EditedShot> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<style>${CSS}</style>
      <div class="ed" tabindex="-1" role="dialog" aria-label="Screenshot editor">
        <div class="bar">
          <button type="button" data-tool="box" aria-pressed="true">Box</button>
          <button type="button" data-tool="arrow" aria-pressed="false">Arrow</button>
          <button type="button" data-tool="pen" aria-pressed="false">Pen</button>
          <span class="sep"></span>
          <span class="swatches" role="group" aria-label="Colour"></span>
          <span class="sep"></span>
          <button type="button" class="undo">Undo</button>
          <button type="button" class="continue">Continue</button>
        </div>
        <div class="body">
          <div class="stage"><img alt=""><canvas></canvas></div>
          <div class="side">
            <h3>Note for this moment (video paused)</h3><textarea class="mark-note" rows="4" placeholder="Note (optional)" aria-label="Screenshot note"></textarea>
            <h3>Shapes</h3>
            <ol class="shapes"></ol>
            <p class="empty">Drag on the image to draw. Each shape gets a number and its own note.</p>
            <p class="hint">Enter in the note = Continue · Shift+Enter = new line · Enter in a shape note finishes it · Ctrl/Cmd+Z = undo</p>
          </div>
        </div>
      </div>`;
    root.appendChild(wrap);
    const ed = wrap.querySelector<HTMLElement>(".ed")!;
    const stage = wrap.querySelector<HTMLElement>(".stage")!;
    const img = wrap.querySelector("img")!;
    const canvas = wrap.querySelector("canvas")!;
    const ctx = canvas.getContext("2d")!;
    const list = wrap.querySelector<HTMLOListElement>(".shapes")!;
    const empty = wrap.querySelector<HTMLElement>(".empty")!;
    const noteBox = wrap.querySelector<HTMLTextAreaElement>(".mark-note")!;
    const shapes: DrawnShape[] = [];
    let tool: ShapeKind = "box";
    let color = opts.color;
    let current: { tool: ShapeKind; points: Pt[]; color: SwatchName } | null = null;
    const lineWidth = Math.max(3, Math.round(3 * opts.dpr));
    const radius = Math.max(11, Math.round(11 * opts.dpr));
    if (noteBox) noteBox.value = opts.note ?? "";

    // Keys and pointer events stay inside the editor; the page must not react to them.
    for (const type of ["keydown", "keyup", "keypress", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "input", "beforeinput", "paste", "copy", "cut"]) {
      ed.addEventListener(type, (e) => e.stopPropagation());
    }
    ed.addEventListener("wheel", (e) => (e.stopPropagation(), e.preventDefault()), { passive: false });

    const swatches = wrap.querySelector<HTMLElement>(".swatches")!;
    for (const s of SWATCHES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sw";
      b.dataset.color = s.name;
      b.title = s.name;
      b.setAttribute("aria-label", s.name);
      b.style.background = s.hex;
      b.setAttribute("aria-pressed", String(s.name === color));
      b.addEventListener("click", () => {
        color = s.name;
        swatches.querySelectorAll(".sw").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        opts.onColor(color);
      });
      swatches.append(b);
    }

    const redraw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of shapes) drawShape(ctx, s, lineWidth);
      shapes.forEach((s, i) => drawBadge(ctx, s, i + 1, radius));
      if (current) drawShape(ctx, current, lineWidth);
    };
    const renderList = () => {
      list.replaceChildren();
      empty.hidden = shapes.length > 0;
      shapes.forEach((s, i) => {
        const li = document.createElement("li");
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(i + 1);
        badge.style.background = swatch(s.color).hex;
        badge.style.color = badgeTextColor(swatch(s.color).hex);
        const what = document.createElement("span");
        what.className = "what";
        what.textContent = `${s.tool} · ${s.color}${s.element ? ` · ${s.element.tag} "${s.element.label}"` : ""}`;
        what.title = what.textContent;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "del";
        del.textContent = "×";
        del.title = "Remove this shape";
        del.addEventListener("click", () => {
          shapes.splice(i, 1);
          renderList();
          redraw();
        });
        const input = document.createElement("input");
        input.className = "shape-note";
        input.dataset.n = String(i + 1);
        input.placeholder = `Note for ${i + 1} (optional)`;
        input.value = s.note;
        input.addEventListener("input", () => (s.note = input.value));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            ed.focus();
          }
        });
        li.append(badge, what, del, input);
        list.append(li);
      });
    };
    const undo = () => {
      shapes.pop();
      renderList();
      redraw();
    };
    const layout = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const box = stage.getBoundingClientRect();
      const scale = Math.min((box.width - 24) / w, (box.height - 24) / h, 1);
      const cw = w * scale;
      const ch = h * scale;
      for (const node of [img, canvas]) {
        node.style.width = `${cw}px`;
        node.style.height = `${ch}px`;
        node.style.left = `${(box.width - cw) / 2}px`;
        node.style.top = `${(box.height - ch) / 2}px`;
      }
    };
    const toImage = (e: PointerEvent): Pt => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
    };
    const finish = (result: EditedShot) => {
      window.removeEventListener("resize", layout);
      wrap.remove();
      resolve(result);
    };
    const save = () => {
      const out = document.createElement("canvas");
      out.width = img.naturalWidth;
      out.height = img.naturalHeight;
      const o = out.getContext("2d")!;
      o.drawImage(img, 0, 0);
      o.drawImage(canvas, 0, 0);
      finish({
        dataUrl: out.toDataURL("image/png"),
        width: out.width,
        height: out.height,
        annotated: shapes.length > 0,
        annotations: toAnnotations(shapes, opts.viewportWidth, out.width),
        note: noteBox.value,
      });
    };

    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      layout();
      if (!ed.contains(root.activeElement)) noteBox.focus({ preventScroll: true });
    };
    img.onerror = () => save();
    img.src = src;
    window.addEventListener("resize", layout);
    noteBox.focus({ preventScroll: true });
    noteBox.addEventListener("input", () => opts.onNoteInput?.(noteBox.value));
    noteBox.addEventListener("keydown", (e) => {
      // 229 / isComposing: Enter that confirms an IME candidate (Thai, Japanese, ...) is not "Continue".
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      save();
    });

    wrap.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
      b.addEventListener("click", () => {
        tool = b.dataset.tool as ShapeKind;
        wrap.querySelectorAll("[data-tool]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      }),
    );
    wrap.querySelector(".undo")!.addEventListener("click", undo);
    wrap.querySelector(".continue")!.addEventListener("click", save);
    ed.addEventListener("keydown", (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Enter" && !typing) save();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) undo();
    });

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      current = { tool, points: [toImage(e)], color };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!current) return;
      const p = toImage(e);
      if (current.tool === "pen") current.points.push(p);
      else current.points[1] = p;
      redraw();
    });
    const end = () => {
      if (!current) return;
      const c = current;
      current = null;
      if (isShape(c.tool, c.points)) {
        const at = probePoint(c.tool, c.points);
        const k = opts.viewportWidth / (canvas.width || 1);
        const element = at ? opts.elementAt(at.x * k, at.y * k) : null;
        shapes.push({ ...c, note: "", ...(element ? { element } : {}) });
        renderList();
        list.querySelector<HTMLInputElement>(`input[data-n="${shapes.length}"]`)?.focus({ preventScroll: true });
      }
      redraw();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  });
}
