"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Fullscreen, Maximize2, ZoomIn, ZoomOut } from "../icons";
import { contourFrame, contourPolylines, DEFAULT_GRAPH_CAMERA, GRAPH_EDGE_LIMIT, layoutGraph, projectGraph, zoomGraphCamera, type GraphCamera, type GraphTopology } from "./graph-scene-layout";
import { graphColors, graphKinds } from "./graph-vocabulary";
import { graphRelationKey } from "./graph-relations";
import type { GraphNode, KnowledgeGraph } from "./types";

interface Props {
  nodes: GraphNode[];
  edges: KnowledgeGraph["edges"];
  selection: string | null;
  onSelect: (id: string) => void;
  nodeLabel: (node: GraphNode) => string;
  details?: ReactNode;
  controls?: ReactNode;
  viewKey?: string;
}
interface Drag {
  pointerId: number; x: number; y: number; camera: GraphCamera;
  node: SVGGElement | null; moved: boolean; rotate: boolean;
}

export function KnowledgeGraphScene({ nodes, edges, selection, onSelect, nodeLabel, details, controls, viewKey }: Props) {
  const { t } = useTranslation();
  const svg = useRef<SVGSVGElement>(null);
  const [svgElement, setSvgElement] = useState<SVGSVGElement | null>(null);
  const mountSvg = useCallback((element: SVGSVGElement | null) => { svg.current = element; setSvgElement(element); }, []);
  const elements = useRef(new Map<string, SVGGElement>());
  const [size, setSize] = useState({ width: 600, height: 340 });
  const [camera, setCamera] = useState(DEFAULT_GRAPH_CAMERA);
  const pendingCamera = useRef(camera);
  const frame = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const previousView = useRef(viewKey);
  const arrowId = useId().replace(/:/g, "");
  const glowId = useId().replace(/:/g, "") + "-glow-";
  const mode = camera.mode ?? "2d";

  const connections = useMemo(() => {
    const ids = new Set(nodes.map(node => node.id));
    const unique = new Map<string, KnowledgeGraph["edges"][number]>();
    for (const edge of edges) {
      if (edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)) continue;
      const pair = edge.kind === "related" ? [edge.source, edge.target].sort() : [edge.source, edge.target];
      unique.set(JSON.stringify([edge.kind, ...pair]), edge);
    }
    return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, edge]) => edge);
  }, [nodes, edges]);
  const topologyKey = JSON.stringify([nodes.map(node => node.id).sort(), connections.slice(0, GRAPH_EDGE_LIMIT).map(edge => [edge.source, edge.target])]);
  const points = useMemo(() => layoutGraph(JSON.parse(topologyKey) as GraphTopology, mode), [topologyKey, mode]);
  const degree = useMemo(() => {
    const neighbors = new Map<string, Set<string>>();
    for (const edge of connections) for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (!neighbors.has(a!)) neighbors.set(a!, new Set());
      neighbors.get(a!)!.add(b!);
    }
    return new Map([...neighbors].map(([id, items]) => [id, items.size]));
  }, [connections]);
  const projected = useMemo(() => projectGraph(points, camera, size.width, size.height), [points, camera, size]);
  const preview = [hovered, focused, selection].find(id => id && projected.has(id)) ?? null;
  const previewNode = nodes.find(node => node.id === preview);
  const connected = useMemo(() => new Set(connections.flatMap(edge => edge.source === preview ? [edge.target] : edge.target === preview ? [edge.source] : [])), [connections, preview]);
  const visibleEdges = useMemo(() => {
    // 2D swaps the always-on edge web for contour terrain: links appear only
    // around the hovered, focused or selected node.
    if (mode === "2d" && !preview) return [];
    return connections.slice().sort((a, b) =>
      Number(b.source === preview || b.target === preview) - Number(a.source === preview || a.target === preview)
      || a.id.localeCompare(b.id))
      .filter(edge => mode !== "2d" || edge.source === preview || edge.target === preview)
      .slice(0, GRAPH_EDGE_LIMIT);
  }, [connections, preview, mode]);
  const terrain = useMemo(() => mode === "2d" ? contourPolylines(points) : [], [points, mode]);
  const terrainFrame = useMemo(() => contourFrame(points, camera, size.width, size.height), [points, camera, size]);
  const ordered = useMemo(() => nodes.slice().sort((a, b) => projected.get(a.id)!.depth - projected.get(b.id)!.depth), [nodes, projected]);
  const tabStop = [focused, selection, nodes[0]?.id].find(id => id && projected.has(id));

  const labels = useMemo(() => {
    const candidates = nodes.slice().sort((a, b) =>
      Number(b.id === preview) - Number(a.id === preview)
      || Number(connected.has(b.id)) - Number(connected.has(a.id))
      || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    const budget = Math.max(3, Math.min(28, Math.floor(size.width * size.height / 18000 * camera.scale)));
    const occupied: { x: number; y: number; width: number }[] = [];
    return candidates.flatMap(node => {
      if (occupied.length >= budget) return [];
      const p = projected.get(node.id)!;
      if (p.x < 12 || p.x > size.width - 12 || p.y < 12 || p.y > size.height - 36) return [];
      const maxCharacters = Math.max(5, Math.min(20, Math.floor((size.width - 24) / 12)));
      const characters = [...node.title];
      const text = characters.length > maxCharacters ? characters.slice(0, maxCharacters - 1).join("") + "…" : node.title;
      const width = Math.min(size.width - 24, [...text].reduce((sum, c) => sum + (/[^\u0000-\u00ff]/.test(c) ? 12 : 7), 0) + 12);
      const x = Math.max(width / 2 + 6, Math.min(size.width - width / 2 - 6, p.x));
      const y = p.y + 23;
      if (occupied.some(box => Math.abs(box.y - y) < 21 && Math.abs(box.x - x) < (box.width + width) / 2 + 5)) return [];
      occupied.push({ x, y, width });
      return [{ id: node.id, text, x, y }];
    });
  }, [nodes, preview, connected, degree, projected, size, camera.scale]);

  const flush = useCallback(() => { frame.current = null; setCamera(pendingCamera.current); }, []);
  const schedule = useCallback((next: GraphCamera) => {
    pendingCamera.current = next;
    if (!document.hidden && frame.current === null) frame.current = requestAnimationFrame(flush);
  }, [flush]);
  const stop = useCallback(() => {
    drag.current = null; setDragging(false);
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    setCamera(pendingCamera.current);
  }, []);
  const zoom = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    schedule(zoomGraphCamera(pendingCamera.current, factor, anchor ?? { x: size.width / 2, y: size.height / 2 }, size.width, size.height));
  }, [schedule, size]);
  const fit = useCallback(() => {
    stop();
    schedule({ ...pendingCamera.current, x: 0, y: 0, scale: 1, yaw: DEFAULT_GRAPH_CAMERA.yaw, pitch: DEFAULT_GRAPH_CAMERA.pitch });
  }, [stop, schedule]);
  const focusSelection = () => {
    const p = selection ? projected.get(selection) : undefined;
    if (p) schedule({ ...pendingCamera.current, x: (camera.x ?? 0) + size.width / 2 - p.x, y: (camera.y ?? 0) + size.height / 2 - p.y });
  };

  useEffect(() => {
    if (previousView.current === viewKey) return;
    previousView.current = viewKey;
    fit();
  }, [viewKey, fit]);
  useEffect(() => {
    const element = svgElement;
    if (!element) return;
    const resize = () => {
      // Keep SVG units in CSS pixels so labels also grow with browser zoom.
      const width = element.clientWidth, height = element.clientHeight;
      if (width && height) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY * unit)) * 0.002), { x: (event.clientX - rect.left) * size.width / (rect.width || size.width), y: (event.clientY - rect.top) * size.height / (rect.height || size.height) });
    };
    const hidden = () => { if (document.hidden) stop(); };
    element.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", hidden); window.addEventListener("blur", stop);
    return () => {
      observer.disconnect(); element.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", hidden); window.removeEventListener("blur", stop);
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    };
  }, [stop, zoom, svgElement, size]);

  const scene = <div className={(expanded ? "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg " : "") + "relative bg-background"}>
    <div className={expanded ? "relative flex min-h-0 flex-1 flex-col" : "relative"}>
      <div className="absolute end-2 top-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap gap-1 rounded-md border border-border bg-background p-1">
        {(["2d", "3d"] as const).map(value => <Button key={value} size="sm" variant={mode === value ? "secondary" : "ghost"} aria-pressed={mode === value} onClick={() => { stop(); schedule({ ...DEFAULT_GRAPH_CAMERA, mode: value }); }}>{value === "2d" ? "2D" : "3D"}</Button>)}
        {[{ icon: ZoomIn, label: "workbench.graph_zoom_in" as const, action: () => zoom(1.25) }, { icon: ZoomOut, label: "workbench.graph_zoom_out" as const, action: () => zoom(0.8) }, { icon: Fullscreen, label: "workbench.graph_reset" as const, action: fit }].map(({ icon: Icon, label, action }) => <Button key={label} size="icon-sm" variant="ghost" aria-label={t(label)} onClick={action}><Icon className="size-4" aria-hidden="true" /></Button>)}
        <Button size="sm" variant="ghost" disabled={!selection || !projected.has(selection)} onClick={focusSelection}>{t("workbench.graph_focus")}</Button>
        {!expanded && <Button size="icon-sm" variant="ghost" aria-label={t("workbench.graph_expand")} onClick={() => { stop(); setHovered(null); setFocused(null); setExpanded(true); }}><Maximize2 className="size-4" aria-hidden="true" /></Button>}
      </div>
      <svg ref={mountSvg} viewBox={"0 0 " + size.width + " " + size.height} className={(expanded ? "h-full min-h-0 flex-1 " : "h-[clamp(24rem,52dvh,48rem)] ") + "w-full touch-none select-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[dragging=true]:cursor-grabbing"} role="group" tabIndex={0} aria-label={t("workbench.graph_canvas")} data-dragging={dragging}
        onPointerDown={event => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          const node = (event.target as Element).closest<SVGGElement>("[data-graph-node]");
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: pendingCamera.current, node, moved: false, rotate: mode === "3d" && !event.shiftKey };
          event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const dx = (event.clientX - current.x) * size.width / (rect.width || size.width), dy = (event.clientY - current.y) * size.height / (rect.height || size.height);
          if (!current.moved && Math.hypot(dx, dy) < 4) return;
          current.moved = true; setHovered(null);
          schedule(current.rotate
            ? { ...current.camera, yaw: current.camera.yaw + dx * 0.007, pitch: Math.max(-1.2, Math.min(1.2, current.camera.pitch + dy * 0.007)) }
            : { ...current.camera, x: (current.camera.x ?? 0) + dx, y: (current.camera.y ?? 0) + dy });
        }}
        onPointerUp={event => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          stop();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (!current.moved && current.node?.dataset.graphNode) { current.node.focus({ preventScroll: true }); onSelect(current.node.dataset.graphNode); }
        }}
        onPointerCancel={stop} onLostPointerCapture={stop}
        onKeyDown={event => {
          if (event.key === "+" || event.key === "=" || event.key === "-") { event.preventDefault(); zoom(event.key === "-" ? 0.8 : 1.25); return; }
          const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
          if (!delta) return;
          event.preventDefault();
          const current = pendingCamera.current;
          schedule(mode === "3d" && event.altKey
            ? { ...current, yaw: current.yaw + delta[0]! * 0.12, pitch: Math.max(-1.2, Math.min(1.2, current.pitch + delta[1]! * 0.12)) }
            : { ...current, x: (current.x ?? 0) + delta[0]! * 40, y: (current.y ?? 0) + delta[1]! * 40 });
        }}>
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" /></marker>
          {graphKinds.map(kind => <radialGradient key={kind} id={glowId + kind}>
            <stop offset="0%" stopColor={graphColors[kind]} stopOpacity={0.9} />
            <stop offset="40%" stopColor={graphColors[kind]} stopOpacity={0.32} />
            <stop offset="100%" stopColor={graphColors[kind]} stopOpacity={0} />
          </radialGradient>)}
        </defs>
        <rect width={size.width} height={size.height} fill="transparent" data-graph-background />
        {terrainFrame && terrain.length > 0 && <g data-graph-terrain transform={"translate(" + terrainFrame.tx + " " + terrainFrame.ty + ") scale(" + terrainFrame.fit + " " + -terrainFrame.fit + ")"} pointerEvents="none" aria-hidden="true">
          {terrain.map((ring, index) => <path key={index} data-graph-contour fill="none" stroke="var(--muted-foreground)"
            strokeOpacity={[0.14, 0.2, 0.27][ring.band]} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
            d={"M" + ring.points.map(point => point[0]!.toFixed(2) + " " + point[1]!.toFixed(2)).join("L") + (ring.closed ? "Z" : "")} />)}
        </g>}
        <g pointerEvents="none" aria-hidden="true">{visibleEdges.map(edge => {
          const a = projected.get(edge.source)!, b = projected.get(edge.target)!;
          const active = edge.source === preview || edge.target === preview;
          // Depth-of-field: links collapse into the background as they recede.
          const near = Math.max(0, Math.min(1, ((a.depth + b.depth) / 2 + 380) / 760));
          const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
          const inset = Math.min(10, distance / 3);
          return <line key={edge.id} data-graph-edge={edge.kind} data-source={edge.source} data-target={edge.target}
            x1={a.x} y1={a.y} x2={b.x - (b.x - a.x) / distance * inset} y2={b.y - (b.y - a.y) / distance * inset}
            stroke="var(--muted-foreground)" strokeWidth={active ? 1.3 : 0.55 + near * 0.55}
            strokeDasharray={edge.kind === "evidence" ? "3 3" : undefined}
            markerEnd={active && edge.kind !== "evidence" ? "url(#" + arrowId + ")" : undefined}
            opacity={active ? 0.8 : preview ? 0.1 : 0.1 + near * 0.4}>
            <title>{t(graphRelationKey[edge.kind as keyof typeof graphRelationKey] ?? "workbench.graph_related")}</title>
          </line>;
        })}</g>
        {ordered.map(node => {
          const p = projected.get(node.id)!;
          const active = node.id === selection;
          const radius = (3 + Math.min(5, Math.log2((degree.get(node.id) ?? 0) + 1) * 1.1)) * (mode === "3d" ? p.size : 1);
          const glow = active || node.id === preview;
          return <g key={node.id} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }}
            data-graph-node={node.id} role="button" tabIndex={node.id === tabStop ? 0 : -1} aria-label={nodeLabel(node)} aria-pressed={active}
            aria-description={t("workbench.graph_connections", { count: degree.get(node.id) ?? 0 })}
            transform={"translate(" + p.x + " " + p.y + ")"} opacity={p.opacity * (preview && node.id !== preview && !connected.has(node.id) ? 0.5 : 1)}
            className="outline-none focus-visible:[&_.graph-focus]:opacity-100"
            onPointerEnter={() => { if (!drag.current) setHovered(node.id); }} onPointerLeave={() => setHovered(null)}
            onFocus={() => {
              setFocused(node.id);
              if (p.x < 24 || p.x > size.width - 24 || p.y < 24 || p.y > size.height - 24) schedule({ ...pendingCamera.current, x: (camera.x ?? 0) + size.width / 2 - p.x, y: (camera.y ?? 0) + size.height / 2 - p.y });
            }} onBlur={() => setFocused(null)}
            onClick={event => { if (event.detail === 0) onSelect(node.id); }}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelect(node.id); return; }
              const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
              if (!direction || event.altKey) return;
              event.preventDefault(); event.stopPropagation();
              const target = nodes.filter(item => item.id !== node.id).map(item => {
                const position = projected.get(item.id)!;
                const dx = position.x - p.x, dy = position.y - p.y;
                const forward = dx * direction[0]! + dy * direction[1]!;
                return { id: item.id, score: forward > 0 ? Math.hypot(dx, dy) + Math.abs(dx * direction[1]! - dy * direction[0]!) * 2 : Infinity };
              }).sort((a, b) => a.score - b.score)[0];
              if (target && Number.isFinite(target.score)) elements.current.get(target.id)?.focus({ preventScroll: true });
            }}>
            <title>{nodeLabel(node)}</title>
            <circle r={16} fill="transparent" />
            <circle className="graph-focus" r={13} fill="none" stroke="var(--ring)" strokeWidth={2} opacity={0} pointerEvents="none" />
            {mode === "3d" && <circle r={radius * 3.6} fill={"url(#" + glowId + node.kind + ")"} opacity={glow ? 0.9 : Math.max(0.22, Math.min(0.8, 0.45 * p.size))} pointerEvents="none" />}
            {mode === "3d" && active && <circle r={radius} fill={"url(#" + glowId + node.kind + ")"} opacity={0.55} pointerEvents="none" aria-hidden="true">
              <animate attributeName="r" values={radius + ";" + radius * 4.4} dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.55;0" dur="1.8s" repeatCount="indefinite" />
            </circle>}
            {mode === "2d" && glow && <circle r={radius * 2.5} fill={graphColors[node.kind]} opacity={0.12} pointerEvents="none" />}
            <circle data-graph-particle r={radius} fill={graphColors[node.kind]} stroke={active ? "var(--foreground)" : "none"} strokeWidth={active ? 1.5 : 0} pointerEvents="none" />
          </g>;
        })}
        {labels.map(label => <text key={label.id} data-graph-label={label.id} x={label.x} y={label.y} textAnchor="middle" fill="var(--foreground)" fontSize={12} paintOrder="stroke" stroke="var(--background)" strokeWidth={4} strokeLinejoin="round" pointerEvents="none" aria-hidden="true">{label.text}</text>)}
      </svg>
      {previewNode && <div data-graph-preview className="absolute bottom-2 start-2 max-h-24 max-w-[calc(100%-1rem)] overflow-y-auto rounded-md border border-border bg-background px-3 py-2 text-xs shadow-sm">
        <p className="break-words font-medium">{nodeLabel(previewNode)}</p><p className="mt-1 text-muted-foreground">{t("workbench.graph_connections", { count: degree.get(previewNode.id) ?? 0 })}</p>
      </div>}
    </div>
    <div className="shrink-0 space-y-1 px-3 py-2">
      <p className="text-xs leading-relaxed text-muted-foreground">{t(mode === "3d" ? "workbench.graph_gestures_3d" : "workbench.graph_gestures")}</p>
      {mode === "3d" && connections.length > visibleEdges.length && <p role="status" className="text-xs text-muted-foreground">{t("workbench.graph_edge_budget", { shown: visibleEdges.length, total: connections.length })}</p>}
    </div>
  </div>;
  return <Dialog open={expanded} onOpenChange={open => { stop(); setHovered(null); setFocused(null); setExpanded(open); }}>
    {!expanded && scene}
    <DialogContent className="flex h-[calc(100dvh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-none flex-col gap-3 p-3 motion-reduce:animate-none motion-reduce:transition-none sm:max-w-none" finalFocus={() => { svg.current?.focus({ preventScroll: true }); return false; }}>
      <DialogHeader className="shrink-0 pe-10"><DialogTitle>{t("workbench.graph_title")}</DialogTitle><DialogDescription>{t("workbench.graph_hint")}</DialogDescription></DialogHeader>
      {expanded && <>
        <div className={"grid min-h-0 flex-1 gap-3 " + (details ? "grid-rows-[minmax(12rem,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:grid-rows-1" : "grid-rows-1")}>
          {scene}{details && <aside className="min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-lg border border-border p-3" aria-label={t("workbench.graph_details")}>
            {controls && <details className="rounded-md border border-border p-2"><summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_search_scope")}</summary><div className="mt-3">{controls}</div></details>}
            {details}
          </aside>}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
