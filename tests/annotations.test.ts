import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR,
  SWATCHES,
  badgeCenter,
  badgeTextColor,
  imageGeometry,
  isShape,
  probePoint,
  scaleGeometry,
  simplify,
  swatch,
  toAnnotations,
  type DrawnShape,
} from "../src/shared/annotations";
import type { ElementInfo } from "../src/shared/types";

const el: ElementInfo = {
  tag: "button",
  label: "Save",
  labelSource: "innerText",
  selector: "#save",
  testId: "save-btn",
  bbox: { x: 10, y: 20, width: 80, height: 30 },
  style: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(37, 99, 235)", fontSize: "14px", fontWeight: "600", display: "inline-block", visibility: "visible" },
};

describe("annotation model", () => {
  it("has the preset swatches, red first, and falls back to red for an unknown name", () => {
    expect(SWATCHES.map((s) => s.name)).toEqual(["red", "yellow", "green", "cyan", "magenta", "white", "black"]);
    expect(DEFAULT_COLOR).toBe("red");
    expect(swatch("magenta").hex).toBe("#d946ef");
    expect(swatch("nope").name).toBe("red");
    expect(swatch(undefined).name).toBe("red");
  });

  it("numbers shapes 1, 2, 3 in drawing order; deleting one renumbers the rest", () => {
    const shapes: DrawnShape[] = [
      { tool: "box", points: [{ x: 300, y: 200 }, { x: 100, y: 100 }], color: "red", note: " first ", element: el },
      { tool: "arrow", points: [{ x: 10, y: 10 }, { x: 50, y: 60 }], color: "yellow", note: "" },
      { tool: "pen", points: [{ x: 0, y: 0 }, { x: 4, y: 8 }, { x: 10, y: 2 }], color: "cyan", note: "loop", element: el },
    ];
    const list = toAnnotations(shapes, 1280, 2560);
    expect(list.map((a) => [a.n, a.shape, a.color, a.hex, a.note])).toEqual([
      [1, "box", "red", "#ff2d55", "first"],
      [2, "arrow", "yellow", "#facc15", ""],
      [3, "pen", "cyan", "#06b6d4", "loop"],
    ]);
    expect(list[0]!.element).toEqual(el);
    expect(list[2]!.element).toBeUndefined();
    expect(toAnnotations(shapes.slice(1), 1280, 2560).map((a) => a.n)).toEqual([1, 2]);
  });

  it("geometry in image px and page CSS px (image * viewport.width / imageWidth)", () => {
    const [box] = toAnnotations([{ tool: "box", points: [{ x: 300.4, y: 200 }, { x: 100, y: 101 }], color: "red", note: "" }], 1280, 2560);
    expect(box!.geometry).toEqual({ image: { x: 100, y: 101, width: 200, height: 99 }, css: { x: 50, y: 50.5, width: 100, height: 49.5 } });
    expect(imageGeometry("arrow", [{ x: 1, y: 2 }, { x: 30, y: 40 }])).toEqual({ from: { x: 1, y: 2 }, to: { x: 30, y: 40 } });
    expect(scaleGeometry({ from: { x: 10, y: 20 }, to: { x: 30, y: 41 } }, 0.5)).toEqual({ from: { x: 5, y: 10 }, to: { x: 15, y: 20.5 } });
    const pen = imageGeometry("pen", [{ x: 5, y: 5 }, { x: 9, y: 1 }, { x: 2, y: 8 }]);
    expect(pen).toEqual({ points: [[5, 5], [9, 1], [2, 8]], bbox: { x: 2, y: 1, width: 7, height: 7 } });
  });

  it("keeps pen strokes compact", () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ x: i, y: i % 7 }));
    const s = simplify(pts);
    expect(s).toHaveLength(64);
    expect(s[0]).toEqual(pts[0]);
    expect(s.at(-1)).toEqual(pts.at(-1));
  });

  it("ignores stray clicks", () => {
    expect(isShape("box", [{ x: 1, y: 1 }])).toBe(false);
    expect(isShape("box", [{ x: 1, y: 1 }, { x: 3, y: 3 }])).toBe(false);
    expect(isShape("arrow", [{ x: 1, y: 1 }, { x: 30, y: 3 }])).toBe(true);
    expect(isShape("pen", [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 1 }])).toBe(false);
  });

  it("looks for the element at a box's centre or an arrow's tip; not for pen strokes", () => {
    expect(probePoint("box", [{ x: 100, y: 100 }, { x: 300, y: 200 }])).toEqual({ x: 200, y: 150 });
    expect(probePoint("arrow", [{ x: 10, y: 10 }, { x: 50, y: 60 }])).toEqual({ x: 50, y: 60 });
    expect(probePoint("pen", [{ x: 10, y: 10 }, { x: 50, y: 60 }])).toBeNull();
  });

  it("puts the badge outside a box's top-left corner, kept inside the image", () => {
    expect(badgeCenter("box", [{ x: 300, y: 200 }, { x: 100, y: 100 }], 22, 2560, 1600)).toEqual({ x: 78, y: 78 });
    expect(badgeCenter("box", [{ x: 0, y: 0 }, { x: 50, y: 50 }], 22, 2560, 1600)).toEqual({ x: 23, y: 23 });
    expect(badgeCenter("arrow", [{ x: 1000, y: 500 }, { x: 10, y: 10 }], 20, 2560, 1600)).toEqual({ x: 984, y: 484 });
    expect(badgeCenter("arrow", [{ x: 2559, y: 1599 }, { x: 10, y: 10 }], 22, 2560, 1600)).toEqual({ x: 2537, y: 1577 });
  });

  it("badge text is readable on every swatch", () => {
    expect(SWATCHES.map((s) => badgeTextColor(s.hex))).toEqual(["#ffffff", "#000000", "#000000", "#000000", "#000000", "#000000", "#ffffff"]);
  });
});
