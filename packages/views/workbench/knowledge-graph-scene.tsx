"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Fullscreen, Maximize2, ZoomIn, ZoomOut } from "../icons";
import { DEFAULT_GRAPH_CAMERA, GRAPH_EDGE_LIMIT, layoutGraph, projectGraph, type GraphCamera, type GraphTopology } from "./graph-scene-layout";
import type { GraphKind, GraphNode, KnowledgeGraph } from "./types";

interface Props {
  nodes: GraphNode[];
  edges: KnowledgeGraph["edges"];
  selection: string | null;
  onSelect: (id: string) => void;
  colors: Record<GraphKind, string>;
  nodeLabel: (node: GraphNode) => string;
}
interface Drag {
  pointerId: number;
  x: number;
  y: number;
  camera: GraphCamera;
  node: SVGGElement | null;
  moved: boolean;
}

export function KnowledgeGraphScene({ nodes, edges, selection, onSelect, colors, nodeLabel }: Props) {
  const { t } = useTranslation();
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 600, height: 340 });
  const [camera, setCamera] = useState(DEFAULT_GRAPH_CAMERA);
  const pendingCamera = useRef(camera);
  const frame = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const connections = useMemo(() => {
    const ids = new Set(nodes.map(node => node.id));
    const unique = new Map<string, [string, string]>();
    for (const edge of edges) {
      if (edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)) continue;
      const pair: [string, string] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
      unique.set(JSON.stringify(pair), pair);
    }
    return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair);
  }, [nodes, edges]);
  const topologyKey = JSON.stringify([nodes.map(node => node.id).sort(), connections.slice(0, GRAPH_EDGE_LIMIT)]);
  const points = useMemo(() => layoutGraph(JSON.parse(topologyKey) as GraphTopology), [topologyKey]);
  const projected = useMemo(() => projectGraph(points, camera, size.width, size.height), [points, camera, size]);
  const visibleEdges = useMemo(() => connections.slice().sort((a, b) =>
    Number(b.includes(selection ?? "")) - Number(a.includes(selection ?? ""))
  ).slice(0, GRAPH_EDGE_LIMIT), [connections, selection]);
  const connected = useMemo(() => new Set(connections.flatMap(([a, b]) => a === selection ? [b] : b === selection ? [a] : [])), [connections, selection]);
  const ordered = useMemo(() => nodes.slice().sort((a, b) => projected.get(a.id)!.depth - projected.get(b.id)!.depth), [nodes, projected]);
  const labelledId = hovered ?? focused ?? selection;
  const labelled = nodes.find(node => node.id === labelledId);
  const visibleSelection = selection !== null && projected.has(selection);

  const flush = useCallback(() => {
    frame.current = null;
    setCamera(pendingCamera.current);
  }, []);
  const schedule = useCallback((next: GraphCamera) => {
    pendingCamera.current = next;
    if (!document.hidden && frame.current === null) frame.current = requestAnimationFrame(flush);
  }, [flush]);
  const stop = useCallback(() => {
    drag.current = null;
    setDragging(false);
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    setCamera(pendingCamera.current);
  }, []);
  const zoom = useCallback((factor: number) => {
    const current = pendingCamera.current;
    schedule({ ...current, scale: Math.max(0.5, Math.min(3, current.scale * factor)) });
  }, [schedule]);

  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const resize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) setSize(previous => previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    // A native listener can cancel scrolling inside the graph, including WebKit.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY * unit)) * 0.002));
    };
    const hidden = () => { if (document.hidden) stop(); };
    element.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", stop);
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", stop);
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    };
  }, [stop, zoom, expanded]);

  const scene = <div className={expanded ? "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-muted/15" : "relative"}>
    <div className="absolute end-2 top-2 z-10 flex gap-1 rounded-md border border-border bg-background p-1">
      {[{ icon: ZoomIn, label: "workbench.graph_zoom_in" as const, action: () => zoom(1.25) }, { icon: ZoomOut, label: "workbench.graph_zoom_out" as const, action: () => zoom(0.8) }, { icon: Fullscreen, label: "workbench.graph_reset" as const, action: () => { stop(); schedule({ ...DEFAULT_GRAPH_CAMERA }); } }].map(({ icon: Icon, label, action }) => <Button key={label} size="icon-sm" variant="ghost" aria-label={t(label)} onClick={action}><Icon className="size-4" /></Button>)}
      {!expanded && <Button size="icon-sm" variant="ghost" aria-label={t("workbench.graph_expand")} onClick={() => { stop(); setExpanded(true); }}><Maximize2 className="size-4" /></Button>}
    </div>
    <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} className={`${expanded ? "h-full min-h-0 flex-1" : "h-[clamp(24rem,52dvh,48rem)]"} w-full touch-none select-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[dragging=true]:cursor-grabbing`} role="group" tabIndex={0} aria-label={t("workbench.graph_canvas")} data-dragging={dragging}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        const node = (event.target as Element).closest<SVGGElement>("[data-graph-node]");
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: pendingCamera.current, node, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < 4) return;
        current.moved = true;
        setHovered(null);
        schedule({ ...current.camera, yaw: current.camera.yaw + dx * 0.007, pitch: Math.max(-1.2, Math.min(1.2, current.camera.pitch + dy * 0.007)) });
      }}
      onPointerUp={event => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        stop();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (!current.moved && current.node?.dataset.graphNode) {
          current.node.focus({ preventScroll: true });
          onSelect(current.node.dataset.graphNode);
        }
      }}
      onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={event => {
        const delta = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, -0.12], ArrowDown: [0, 0.12] }[event.key];
        if (!delta) return;
        event.preventDefault();
        const current = pendingCamera.current;
        schedule({ ...current, yaw: current.yaw + delta[0]!, pitch: Math.max(-1.2, Math.min(1.2, current.pitch + delta[1]!)) });
      }}>
      <rect width={size.width} height={size.height} fill="transparent" data-graph-background />
      <g pointerEvents="none" aria-hidden="true">{visibleEdges.map(([source, target]) => {
        const a = projected.get(source)!, b = projected.get(target)!;
        const active = source === selection || target === selection;
        return <line key={JSON.stringify([source, target])} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted-foreground)" strokeWidth={active ? 1.05 : 0.75} opacity={active ? 0.48 : visibleSelection ? 0.18 : 0.2 + (a.opacity + b.opacity) * 0.065} />;
      })}</g>
      {ordered.map(node => {
        const p = projected.get(node.id)!;
        const active = node.id === selection;
        const radius = (node.kind === "source" ? 3 : 4.5) * p.size;
        return <g key={node.id} data-graph-node={node.id} role="button" tabIndex={0} aria-label={nodeLabel(node)} aria-pressed={active}
          transform={`translate(${p.x} ${p.y})`} opacity={Math.max(0.6, p.opacity) * (visibleSelection && !active && !connected.has(node.id) ? 0.65 : 1)}
          className="outline-none focus-visible:[&_.graph-focus]:opacity-100"
          onPointerEnter={() => { if (!drag.current) setHovered(node.id); }} onPointerLeave={() => setHovered(null)}
          onFocus={() => setFocused(node.id)} onBlur={() => setFocused(null)}
          onClick={event => { if (event.detail === 0) onSelect(node.id); }}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelect(node.id); } }}>
          <title>{node.title}</title>
          <circle r={16} fill="transparent" />
          <circle className="graph-focus" r={13} fill="none" stroke="var(--ring)" strokeWidth={2} opacity={0} pointerEvents="none" />
          <circle r={radius * 3.2} fill={colors[node.kind]} opacity={active || node.id === hovered ? 0.12 : 0.04} pointerEvents="none" />
          <circle r={radius * 1.8} fill={colors[node.kind]} opacity={active || node.id === hovered ? 0.2 : 0.08} pointerEvents="none" />
          <circle r={radius} fill={colors[node.kind]} stroke={active ? "var(--foreground)" : "none"} strokeWidth={active ? 1.5 : 0} pointerEvents="none" />
        </g>;
      })}
      {labelled && (() => {
        const p = projected.get(labelled.id)!;
        const title = [...labelled.title];
        const text = title.length > 16 ? `${title.slice(0, 15).join("")}…` : labelled.title;
        return <text x={Math.max(Math.min(90, size.width / 2), Math.min(size.width - Math.min(90, size.width / 2), p.x))} y={Math.max(16, Math.min(size.height - 8, p.y + 26))} textAnchor="middle" fill="var(--foreground)" fontSize={12} paintOrder="stroke" stroke="var(--background)" strokeWidth={3} strokeLinejoin="round" pointerEvents="none" aria-hidden="true">{text}</text>;
      })()}
    </svg>
  </div>;
  return <Dialog open={expanded} onOpenChange={open => { stop(); setExpanded(open); }}>
    {!expanded && scene}
    <DialogContent className="flex h-[calc(100dvh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-none flex-col gap-3 p-3 sm:max-w-none" finalFocus={() => { svg.current?.focus({ preventScroll: true }); return false; }}>
      <DialogHeader className="shrink-0 pe-10">
        <DialogTitle>{t("workbench.graph_title")}</DialogTitle>
        <DialogDescription>{t("workbench.graph_hint")}</DialogDescription>
      </DialogHeader>
      {expanded && scene}
    </DialogContent>
  </Dialog>;
}
