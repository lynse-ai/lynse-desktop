/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeGraphScene } from "./knowledge-graph-scene";
import type { GraphNode, KnowledgeGraph } from "./types";

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const nodes: GraphNode[] = ["Alpha", "Beta", "Gamma"].map(title => ({ id: title, title, kind: "topic", status: "active", description: "", citations: [], updates: [] }));
const edges: KnowledgeGraph["edges"] = [{ id: "ab", source: "Alpha", target: "Beta", kind: "related" }];
const frames = new Map<number, FrameRequestCallback>();
let serial = 0;
const onSelect = vi.fn();
const props = { nodes, edges, selection: null, onSelect, nodeLabel: (node: GraphNode) => node.title };

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
}
function preparePointer() {
  const element = screen.getByRole("group") as unknown as SVGSVGElement;
  Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false), releasePointerCapture: vi.fn() });
  return element;
}

beforeEach(() => {
  serial = 0; frames.clear(); onSelect.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("particle knowledge graph", () => {
  it("hides idle 2D edges behind contour terrain and does not dim nodes for an offscreen selection", () => {
    const { container, rerender } = render(<KnowledgeGraphScene {...props} />);
    expect(container.querySelectorAll('[role="group"] line')).toHaveLength(0);
    expect(container.querySelectorAll("[data-graph-contour]").length).toBeGreaterThan(0);
    expect(container.querySelector('circle[fill^="url(#"]')).toBeNull();
    const opacity = [...container.querySelectorAll("[data-graph-node]")].map(node => node.getAttribute("opacity"));
    rerender(<KnowledgeGraphScene {...props} selection="not-visible" />);
    expect([...container.querySelectorAll("[data-graph-node]")].map(node => node.getAttribute("opacity"))).toEqual(opacity);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Beta" }));
    const line = container.querySelector('[role="group"] line')!;
    expect(line.getAttribute("opacity")).toBe("0.8");
  });

  it("renders only real relationships and reveals names on hover or keyboard focus", () => {
    const { container } = render(<KnowledgeGraphScene {...props} edges={[...edges,
      { ...edges[0]!, id: "duplicate", source: "Beta", target: "Alpha" },
      { ...edges[0]!, id: "missing", target: "not-visible" },
      { ...edges[0]!, id: "self", target: "Alpha" },
    ]} />);
    expect(screen.getAllByRole("button").filter(element => element.hasAttribute("data-graph-node"))).toHaveLength(3);
    expect(container.querySelectorAll('[role="group"] line')).toHaveLength(0);
    expect(container.querySelectorAll("[data-graph-label]").length).toBeGreaterThan(0);
    const beta = screen.getByRole("button", { name: "Beta" });
    fireEvent.pointerEnter(beta);
    expect(container.querySelectorAll('[role="group"] line')).toHaveLength(1);
    expect(container.querySelector("[data-graph-preview]")?.textContent).toContain("Beta");
    expect(container.querySelector("[data-graph-edge]")?.getAttribute("opacity")).toBe("0.8");
    expect(Number(screen.getByRole("button", { name: "Gamma" }).getAttribute("opacity"))).toBeLessThan(1);
    fireEvent.pointerLeave(beta);
    fireEvent.focus(beta);
    fireEvent.keyDown(beta, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("Beta");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("coalesces pan updates without selecting the dragged node and stays idle after release", () => {
    render(<KnowledgeGraphScene {...props} />);
    const svg = preparePointer();
    const node = screen.getByRole("button", { name: "Beta" });
    const before = node.getAttribute("transform");
    fireEvent.pointerDown(node, { button: 0, clientX: 100, clientY: 100, pointerId: 4 });
    fireEvent.pointerMove(svg, { clientX: 130, clientY: 120, pointerId: 4 });
    fireEvent.pointerMove(svg, { clientX: 155, clientY: 125, pointerId: 4 });
    expect(frames.size).toBe(1);
    expect(svg.getAttribute("data-dragging")).toBe("true");
    flushFrames();
    expect(node.getAttribute("transform")).not.toBe(before);
    fireEvent.pointerUp(svg, { pointerId: 4 });
    fireEvent.click(node, { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
    expect(svg.getAttribute("data-dragging")).toBe("false");
    expect(frames.size).toBe(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("selects a click with small pointer jitter and supports wheel and keyboard rotation", () => {
    render(<KnowledgeGraphScene {...props} />);
    const svg = preparePointer();
    const node = screen.getByRole("button", { name: "Beta" });
    Object.assign(node, { focus: vi.fn() });
    fireEvent.pointerDown(node, { button: 0, clientX: 100, clientY: 100, pointerId: 5 });
    fireEvent.pointerMove(svg, { clientX: 101, clientY: 101, pointerId: 5 });
    fireEvent.pointerUp(svg, { pointerId: 5 });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("Beta");
    const before = node.getAttribute("transform");
    fireEvent.wheel(svg, { deltaY: -80, cancelable: true });
    flushFrames();
    expect(node.getAttribute("transform")).not.toBe(before);
    const zoomed = node.getAttribute("transform");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    flushFrames();
    expect(node.getAttribute("transform")).not.toBe(zoomed);
    expect(frames.size).toBe(0);
  });

  it("uses the theme particle token and rotates the view by dragging in 3D", () => {
    const { container } = render(<KnowledgeGraphScene {...props} />);
    expect([...container.querySelectorAll("[data-graph-particle]")].every(node => node.getAttribute("fill") === "var(--graph-topic)")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    flushFrames();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(container.querySelectorAll("[data-graph-contour]")).toHaveLength(0);
    expect(container.querySelectorAll("radialGradient")).toHaveLength(5);
    expect(container.querySelectorAll('circle[fill^="url(#"]').length).toBeGreaterThan(0);
    const svg = preparePointer();
    const node = screen.getByRole("button", { name: "Beta" });
    const initial = node.getAttribute("transform");
    fireEvent.pointerDown(svg, { button: 0, clientX: 100, clientY: 100, pointerId: 7 });
    fireEvent.pointerMove(svg, { clientX: 140, clientY: 118, pointerId: 7 });
    expect(frames.size).toBe(1);
    flushFrames();
    expect(node.getAttribute("transform")).not.toBe(initial);
    fireEvent.pointerUp(svg, { pointerId: 7 });
    expect(svg.getAttribute("data-dragging")).toBe("false");
    expect(frames.size).toBe(0);
  });

  it("keeps distinct relationship kinds and directions between the same pair", () => {
    const { container } = render(<KnowledgeGraphScene {...props} selection="Alpha" edges={[
      ...edges,
      { id: "wiki-forward", source: "Alpha", target: "Beta", kind: "wiki_link" },
      { id: "wiki-back", source: "Beta", target: "Alpha", kind: "wiki_link" },
      { id: "proof", source: "Alpha", target: "Beta", kind: "evidence" },
    ]} />);
    expect(container.querySelectorAll("[data-graph-edge]")).toHaveLength(4);
    expect(container.querySelectorAll('[data-graph-edge="wiki_link"][marker-end]')).toHaveLength(2);
    expect(container.querySelector('[data-graph-edge="evidence"]')?.getAttribute("stroke-dasharray")).toBe("3 3");
  });

  it("pulses the selected node's glow outward in 3D only", () => {
    const { container } = render(<KnowledgeGraphScene {...props} selection="Beta" />);
    expect(container.querySelectorAll("animate")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    flushFrames();
    expect(container.querySelectorAll("animate").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps one node in the tab order and sizes nodes by connection count", () => {
    const { container } = render(<KnowledgeGraphScene {...props} selection="Beta" />);
    expect(container.querySelectorAll('[data-graph-node][tabindex="0"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("tabindex")).toBe("0");
    const alpha = container.querySelector('[data-graph-node="Alpha"] [data-graph-particle]')!;
    const beta = container.querySelector('[data-graph-node="Beta"] [data-graph-particle]')!;
    const gamma = container.querySelector('[data-graph-node="Gamma"] [data-graph-particle]')!;
    expect(alpha.getAttribute("r")).toBe(beta.getAttribute("r"));
    expect(Number(alpha.getAttribute("r"))).toBeGreaterThan(Number(gamma.getAttribute("r")));
  });

  it("shows full long titles in the preview instead of losing their suffix", () => {
    const title = "A long project name whose final milestone must remain available to the reader";
    const { container } = render(<KnowledgeGraphScene {...props} nodes={[{ ...nodes[0]!, title }]} selection="Alpha" />);
    expect(container.querySelector("[data-graph-preview]")?.textContent).toContain(title);
  });

  it("cancels queued work when hidden or unmounted", () => {
    const { unmount } = render(<KnowledgeGraphScene {...props} />);
    const svg = preparePointer();
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(frames.size).toBe(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    vi.restoreAllMocks();
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it("bounds dense graphs and keeps positions stable when details refresh", () => {
    const denseNodes = Array.from({ length: 90 }, (_, i) => ({ ...nodes[0]!, id: `node-${i}`, title: `Node ${i}` }));
    const denseEdges = denseNodes.flatMap((a, i) => denseNodes.slice(i + 1).map(b => ({ id: `${a.id}:${b.id}`, source: a.id, target: b.id, kind: "related" })));
    const { container, rerender } = render(<KnowledgeGraphScene {...props} nodes={denseNodes} edges={denseEdges} />);
    expect(container.querySelectorAll('[role="group"] line')).toHaveLength(0);
    const before = [...container.querySelectorAll("[data-graph-node]")].map(node => [node.getAttribute("data-graph-node"), node.getAttribute("transform")]);
    rerender(<KnowledgeGraphScene {...props} nodes={denseNodes.map(node => ({ ...node, description: "New progress" }))} edges={denseEdges.map(edge => ({ ...edge }))} selection="node-89" />);
    expect([...container.querySelectorAll("[data-graph-node]")].map(node => [node.getAttribute("data-graph-node"), node.getAttribute("transform")])).toEqual(before);
    expect(container.querySelectorAll('[role="group"] line')).toHaveLength(89);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Node 88" }));
    expect([...container.querySelectorAll("[data-graph-edge]")].filter(edge => edge.getAttribute("data-source") === "node-88" || edge.getAttribute("data-target") === "node-88")).toHaveLength(89);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
