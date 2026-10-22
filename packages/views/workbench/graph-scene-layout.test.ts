import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPH_CAMERA, layoutGraph, projectGraph, zoomGraphCamera } from "./graph-scene-layout";

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
});
