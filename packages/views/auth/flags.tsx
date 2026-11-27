/**
 * Tiny hand-drawn flag marks for the region switcher. Real SVG instead of
 * emoji flags on purpose: Windows renders flag emoji as two-letter codes
 * ("CN" / "US"), so the desktop welcome window needs vectors. Colors are the
 * official flag colors — brand artwork, not UI theming, so design tokens
 * don't apply here.
 */

/** 5-point star path (outer radius r, standard 0.382 inner radius), point up. */
function starPath(cx: number, cy: number, r: number): string {
  const points: string[] = [];
  for (let i = 0; i < 5; i++) {
    const outer = ((90 + i * 72) * Math.PI) / 180;
    const inner = ((90 + i * 72 + 36) * Math.PI) / 180;
    points.push(
      `${(cx + r * Math.cos(outer)).toFixed(3)},${(cy - r * Math.sin(outer)).toFixed(3)}`,
      `${(cx + r * 0.382 * Math.cos(inner)).toFixed(3)},${(cy - r * 0.382 * Math.sin(inner)).toFixed(3)}`,
    );
  }
  return `M${points.join("L")}Z`;
}

export type RegionFlagId = "cn" | "intl";

export function RegionFlag({ region, className }: { region: RegionFlagId; className?: string }) {
  const clipId = `region-flag-clip-${region}`;
  return (
    <svg viewBox="0 0 20 14" className={className} aria-hidden focusable="false">
      <defs>
        {/* Rounded clip shared by the flat color fields; the caller frames it
            further (rounded + hairline ring) via CSS. */}
        <clipPath id={clipId}>
          <rect width="20" height="14" rx="3" />
        </clipPath>
      </defs>
      {region === "cn" ? (
        <g clipPath={`url(#${clipId})`}>
          <rect width="20" height="14" fill="#DE2910" />
          <path d={starPath(3.4, 3.2, 2.1)} fill="#FFDE00" />
          {/* Four small stars arced to the flag's right, per the official layout. */}
          <path d={starPath(6.7, 1.3, 0.7)} fill="#FFDE00" />
          <path d={starPath(8.1, 2.7, 0.7)} fill="#FFDE00" />
          <path d={starPath(8.1, 4.5, 0.7)} fill="#FFDE00" />
          <path d={starPath(6.7, 5.9, 0.7)} fill="#FFDE00" />
        </g>
      ) : (
        <g clipPath={`url(#${clipId})`}>
          {/* US flag: 13 stripes → band ≈ 14/13; red field with white bands
              over it, canton spanning the top 7 bands with a dot grid. */}
          <rect width="20" height="14" fill="#B22234" />
          {[1, 3, 5, 7, 9, 11].map((band) => (
            <rect
              key={band}
              y={(band * 14) / 13}
              width="20"
              height={14 / 13}
              fill="#FFFFFF"
            />
          ))}
          <rect width="8.6" height={(7 * 14) / 13} fill="#3C3B6E" />
          {[1.4, 3.4, 5.4, 7.4].map((x) =>
            [1.3, 3.2, 5.1, 7.0].map((y) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="0.42" fill="#FFFFFF" />
            )),
          )}
        </g>
      )}
    </svg>
  );
}
