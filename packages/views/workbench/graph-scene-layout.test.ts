import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPH_CAMERA, contourFrame, contourPolylines, layoutGraph, projectGraph, zoomGraphCamera, type GraphPoint } from "./graph-scene-layout";

describe("graph camera navigation", () => {
  it("keeps the point under the pointer fixed while zooming, including after panning", () => {
    const points = layoutGraph([["a", "b", "c"], [["a", "b"]]], "2d");
    const camera = { ...DEFAULT_GRAPH_CAMERA, x: 70, y: -30 };
    const before = projectGraph(points, camera, 600, 400).get("b")!;
    const next = zoomGraphCamera(camera, 2, before, 600, 400);
    const after = projectGraph(points, next, 600, 400).get("b")!;
    expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y);
    const moved = projectGraph(points, { ...next, x: next.x! + 90, y: next.y! - 20 }, 600, 400).get("b")!;
    expect(moved.x - after.x).toBeCloseTo(90); expect(moved.y - after.y).toBeCloseTo(-20);
  });
  it("bounds zoom and uses a stable flat projection for 2D", () => {
    const points = layoutGraph([["a", "b"], [["a", "b"]]], "2d");
    expect([...points.values()].every(point => point.z === 0)).toBe(true);
    const a = projectGraph(points, DEFAULT_GRAPH_CAMERA, 600, 400);
    expect(projectGraph(points, { ...DEFAULT_GRAPH_CAMERA, yaw: 2, pitch: 1 }, 600, 400)).toEqual(a);
    expect(zoomGraphCamera(DEFAULT_GRAPH_CAMERA, 100, { x: 300, y: 200 }, 600, 400).scale).toBe(4);
    expect(zoomGraphCamera(DEFAULT_GRAPH_CAMERA, 0.01, { x: 300, y: 200 }, 600, 400).scale).toBe(0.5);
  });
  it("maps contour rings with the same 2D projection as the nodes", () => {
    const points = layoutGraph([["a", "b", "c", "d"], [["a", "b"], ["c", "d"]]], "2d");
    const camera = { ...DEFAULT_GRAPH_CAMERA, x: 40, y: 25, scale: 1.4 };
    const sample: GraphPoint = { x: 12, y: -30, z: 0 };
    const combined = new Map([...points, ["s", sample]]);
    const frame = contourFrame(combined, camera, 600, 400)!;
    const projected = projectGraph(combined, camera, 600, 400).get("s")!;
    expect(frame.fit * sample.x + frame.tx).toBeCloseTo(projected.x);
    expect(-frame.fit * sample.y + frame.ty).toBeCloseTo(projected.y);
    expect(contourFrame(combined, { ...camera, mode: "3d" }, 600, 400)).toBeNull();
  });
  it("extracts closed density rings around clusters", () => {
    const points = new Map<string, GraphPoint>([
      ["a", { x: -120, y: -40, z: 0 }], ["b", { x: -95, y: -25, z: 0 }], ["c", { x: -110, y: -55, z: 0 }],
      ["d", { x: 140, y: 90, z: 0 }], ["e", { x: 160, y: 110, z: 0 }],
    ]);
    const rings = contourPolylines(points);
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring.points.length).toBeGreaterThanOrEqual(2);
      if (ring.closed) {
        const head = ring.points[0]!, tail = ring.points[ring.points.length - 1]!;
        expect(Math.hypot(head[0] - tail[0], head[1] - tail[1])).toBeLessThan(25);
      }
    }
    expect(rings.some(ring => ring.closed)).toBe(true);
    expect(contourPolylines(new Map([["a", { x: 0, y: 0, z: 0 }]]))).toEqual([]);
  });
});
