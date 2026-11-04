"use client";

import { useId, useMemo } from "react";
import type { NoteFishbone } from "@lynse/core/api";

/** Fishbone (Ishikawa) diagram for a meeting topic: a horizontal spine
 *  carrying the "why" question, with cause branches as diagonal ribs
 *  alternating above and below. Branch weight scales with evidence support
 *  (0 = weak: dashed, thin, dimmed) so the picture stays honest about what
 *  the transcript actually backs. Pure SVG + theme tokens, no graph lib. */

const WIDTH = 640;
const HEAD_W = 148;
const SPINE_Y = 130;
const RIB_DX = 34;
const RIB_DY = 44;
const RIB_MIN_GAP = 96;

export function FishboneDiagram({ fishbone }: { fishbone: NoteFishbone }) {
  const clipId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const layout = useMemo(() => {
    const branches = fishbone.branches;
    const spineStartX = HEAD_W + 26;
    const usable = WIDTH - spineStartX - 24;
    const gap = branches.length > 1
      ? Math.max(RIB_MIN_GAP, usable / (branches.length - 1))
      : usable / 2;
    return branches.map((branch, index) => {
      const up = index % 2 === 0;
      const anchorX = spineStartX + Math.min(usable, gap * (branches.length > 1 ? index : 0.5));
      const tipX = anchorX - RIB_DX;
      const tipY = SPINE_Y + (up ? -RIB_DY : RIB_DY);
      return { branch, up, anchorX, tipX, tipY, index };
    });
  }, [fishbone.branches]);
  const height = SPINE_Y + RIB_DY + 46;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="w-full"
      role="img"
      aria-label={fishbone.question}
    >
      <defs>
        <marker id={`arrow-${clipId}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </marker>
      </defs>
      {/* Spine */}
      <line
        x1={HEAD_W + 12} y1={SPINE_Y} x2={WIDTH - 16} y2={SPINE_Y}
        stroke="currentColor" strokeWidth="2" markerEnd={`url(#arrow-${clipId})`}
        className="text-foreground/70"
      />
      {/* Question head */}
      <rect x={6} y={SPINE_Y - 22} width={HEAD_W} height={44} rx={10}
        className="fill-primary/10 stroke-primary/50" strokeWidth={1.2} />
      <text x={HEAD_W / 2 + 6} y={SPINE_Y - 5} textAnchor="middle" className="fill-foreground" fontSize={11} fontWeight={600}>
        {truncate(fishbone.question, 10)}
      </text>
      <text x={HEAD_W / 2 + 6} y={SPINE_Y + 10} textAnchor="middle" className="fill-muted-foreground" fontSize={9}>
        {fishbone.question.length > 10 ? "…" : ""}
      </text>
      {/* Branches */}
      {layout.map(({ branch, up, anchorX, tipX, tipY, index }) => {
        const weak = branch.support === 0;
        const weight = weak ? 1 : Math.min(3, 1 + branch.support * 0.5);
        const labelY = up ? tipY - 6 : tipY + 14;
        return (
          <g key={`${index}-${branch.label}`} opacity={weak ? 0.55 : 1}>
            <line
              x1={anchorX} y1={SPINE_Y} x2={tipX} y2={tipY}
              stroke="currentColor" strokeWidth={weight}
              strokeDasharray={weak ? "4 3" : undefined}
              strokeLinecap="round"
              className="text-primary/70"
            />
            <circle cx={anchorX} cy={SPINE_Y} r={2.2} className="fill-primary/70" />
            <text x={tipX} y={labelY} textAnchor="middle" fontSize={11} fontWeight={weak ? 400 : 600}
              className="fill-foreground">
              {truncate(branch.label, 9)}
            </text>
            <title>{weak ? `${branch.label}（证据较弱）` : `${branch.label} — ${branch.detail}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
