export interface GraphPoint { x: number; y: number; z: number }
export interface GraphCamera { yaw: number; pitch: number; scale: number; x?: number; y?: number; mode?: "2d" | "3d" }
export type GraphTopology = [string[], [string, string][]];

export const GRAPH_EDGE_LIMIT = 400;
export const DEFAULT_GRAPH_CAMERA: GraphCamera = { yaw: -0.3, pitch: -0.14, scale: 1, x: 0, y: 0, mode: "2d" };

function initialPoint(id: string): GraphPoint {
  let seed = 2166136261;
  for (const character of id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let x = 0, y = 0, z = 0;
  do { x = random() * 2 - 1; y = random() * 2 - 1; z = random() * 2 - 1; } while (x * x + y * y + z * z > 1);
  return { x: x * 270, y: y * 166, z: z * 195 };
}

// Run only when visible topology changes, never as a continuous simulation.
export function layoutGraph([ids, links]: GraphTopology, mode: "2d" | "3d" = "3d"): Map<string, GraphPoint> {
  const points = new Map(ids.map(id => [id, initialPoint(id)]));
  if (mode === "2d") for (const point of points.values()) point.z = 0;
  if (ids.length === 1) { points.set(ids[0]!, { x: 0, y: 0, z: 0 }); return points; }
  for (let step = 0; step < (mode === "2d" ? 48 : 16); step++) {
    const deltas = new Map(ids.map(id => [id, { x: 0, y: 0, z: 0 }]));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = points.get(ids[i]!)!, b = points.get(ids[j]!)!;
      const dx = a.x - b.x || 0.1, dy = a.y - b.y || 0.1, dz = mode === "2d" ? 0 : a.z - b.z || 0.1;
      const distance = Math.max(20, Math.hypot(dx, dy, dz));
      const force = Math.min(8, (mode === "2d" ? 10000 : 2200) / (distance * distance));
      const da = deltas.get(ids[i]!)!, db = deltas.get(ids[j]!)!;
      da.x += dx / distance * force; da.y += dy / distance * force; da.z += dz / distance * force;
      db.x -= dx / distance * force; db.y -= dy / distance * force; db.z -= dz / distance * force;
    }
    for (const [source, target] of links) {
      const a = points.get(source)!, b = points.get(target)!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const force = (distance - 90) * 0.012;
      const da = deltas.get(source)!, db = deltas.get(target)!;
      da.x += dx / distance * force; da.y += dy / distance * force; da.z += dz / distance * force;
      db.x -= dx / distance * force; db.y -= dy / distance * force; db.z -= dz / distance * force;
    }
    for (const id of ids) {
      const p = points.get(id)!, d = deltas.get(id)!;
      p.x = Math.max(-270, Math.min(270, p.x + d.x - p.x * 0.001));
      p.y = Math.max(-175, Math.min(175, p.y + d.y - p.y * 0.001));
      p.z = Math.max(-195, Math.min(195, p.z + d.z - p.z * 0.001));
    }
  }
  if (!ids.length) return points;
  const values = [...points.values()];
  const center = {
    x: (Math.min(...values.map(p => p.x)) + Math.max(...values.map(p => p.x))) / 2,
    y: (Math.min(...values.map(p => p.y)) + Math.max(...values.map(p => p.y))) / 2,
    z: (Math.min(...values.map(p => p.z)) + Math.max(...values.map(p => p.z))) / 2,
  };
  for (const p of values) { p.x -= center.x; p.y -= center.y; p.z -= center.z; }
  return points;
}

export function projectGraph(points: Map<string, GraphPoint>, camera: GraphCamera, width: number, height: number) {
  const sinYaw = Math.sin(camera.yaw), cosYaw = Math.cos(camera.yaw);
  const sinPitch = Math.sin(camera.pitch), cosPitch = Math.cos(camera.pitch);
  const raw = [...points].map(([id, p]) => {
    if (camera.mode === "2d") return { id, x: p.x, y: p.y, depth: 0, perspective: 1 };
    const x = p.x * cosYaw + p.z * sinYaw;
    const z = -p.x * sinYaw + p.z * cosYaw;
    const y = p.y * cosPitch - z * sinPitch;
    const depth = p.y * sinPitch + z * cosPitch;
    const perspective = 750 / (750 - depth);
    return { id, x: x * perspective, y: y * perspective, depth, perspective };
  });
  if (!raw.length) return new Map<string, { x: number; y: number; depth: number; size: number; opacity: number }>();
  const frame = layoutFrame(camera.mode === "2d" ? [...points.values()] : raw, camera, width, height);
  // Fit the actual cloud to the rectangular viewport instead of an enclosing sphere.
  return new Map(raw.map(p => [p.id, {
    x: width / 2 + (p.x - frame.midX) * frame.fit + (camera.x ?? 0),
    y: height / 2 - (p.y - frame.midY) * frame.fit + (camera.y ?? 0),
    depth: p.depth,
    size: Math.max(0.4, Math.min(2.1, p.perspective)),
    opacity: camera.mode === "2d" ? 1 : Math.max(0.35, Math.min(1, 0.78 + p.depth / 1000)),
  }]));
}

function layoutFrame(values: { x: number; y: number }[], camera: GraphCamera, width: number, height: number) {
  const minX = Math.min(...values.map(p => p.x)), maxX = Math.max(...values.map(p => p.x));
  const minY = Math.min(...values.map(p => p.y)), maxY = Math.max(...values.map(p => p.y));
  const fit = Math.min(Math.max(1, width * 0.84) / Math.max(140, maxX - minX), Math.max(1, height * 0.84) / Math.max(140, maxY - minY)) * camera.scale;
  return { fit, midX: (minX + maxX) / 2, midY: (minY + maxY) / 2 };
}

/** Transform matching the 2D branch of projectGraph, for drawing graph-space
 *  overlays (contours) inside one SVG `<g transform>`. */
export function contourFrame(points: Map<string, GraphPoint>, camera: GraphCamera, width: number, height: number) {
  if (camera.mode === "3d" || !points.size) return null;
  const frame = layoutFrame([...points.values()], camera, width, height);
  return { fit: frame.fit,
    tx: width / 2 - frame.midX * frame.fit + (camera.x ?? 0),
    ty: height / 2 + frame.midY * frame.fit + (camera.y ?? 0) };
}

export interface ContourRing { band: number; closed: boolean; points: [number, number][] }

// Bandwidth in layout units — one contour band spans roughly a cluster.
const CONTOUR_BANDWIDTH = 85;
const CONTOUR_BANDS = [0.22, 0.45, 0.68];

/** Deterministic density terrain: Gaussian kernel over the flat layout,
 *  marching-squares rings per band. Rebuilt only when the topology changes. */
export function contourPolylines(points: Map<string, GraphPoint>, bandwidth: number = CONTOUR_BANDWIDTH): ContourRing[] {
  const values = [...points.values()];
  if (values.length < 2) return [];
  const minX = Math.min(...values.map(p => p.x)), maxX = Math.max(...values.map(p => p.x));
  const minY = Math.min(...values.map(p => p.y)), maxY = Math.max(...values.map(p => p.y));
  const pad = bandwidth * 2.6, columns = 60, rows = 42;
  const x0 = minX - pad, y0 = minY - pad, stepX = (maxX - minX + pad * 2) / columns, stepY = (maxY - minY + pad * 2) / rows;
  const field = new Float64Array((columns + 1) * (rows + 1));
  const denominator = 2 * bandwidth * bandwidth;
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const x = x0 + column * stepX, y = y0 + row * stepY;
    let sum = 0;
    for (const point of values) { const dx = x - point.x, dy = y - point.y; sum += Math.exp(-(dx * dx + dy * dy) / denominator); }
    field[row * (columns + 1) + column] = sum;
  }
  const max = Math.max(...field);
  if (!(max > 0)) return [];
  const segments: [number, number, number, number][] = [];
  const rings: ContourRing[] = [];
  const at = (column: number, row: number) => field[row * (columns + 1) + column]!;
  const alongX = (column: number, t: number) => x0 + (column + t) * stepX;
  const alongY = (row: number, t: number) => y0 + (row + t) * stepY;
  for (let band = 0; band < CONTOUR_BANDS.length; band++) {
    const level = CONTOUR_BANDS[band]! * max;
    const cross = (a: number, b: number) => (level - a) / (b - a);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const tl = at(column, row), tr = at(column + 1, row), br = at(column + 1, row + 1), bl = at(column, row + 1);
      let code = 0;
      if (tl > level) code |= 8;
      if (tr > level) code |= 4;
      if (br > level) code |= 2;
      if (bl > level) code |= 1;
      if (code === 0 || code === 15) continue;
      const top: [number, number] = [alongX(column, cross(tl, tr)), alongY(row, 0)];
      const right: [number, number] = [alongX(column + 1, 0), alongY(row, cross(tr, br))];
      const bottom: [number, number] = [alongX(column, cross(bl, br)), alongY(row + 1, 0)];
      const left: [number, number] = [alongX(column, 0), alongY(row, cross(tl, bl))];
      const saddle = (tl + tr + br + bl) / 4 > level;
      const link = (a: [number, number], b: [number, number]) => segments.push([a[0], a[1], b[0], b[1]]);
      switch (code) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5:
          if (saddle) { link(left, top); link(bottom, right); }
          else { link(left, bottom); link(top, right); }
          break;
        case 10:
          if (saddle) { link(left, bottom); link(top, right); }
          else { link(left, top); link(bottom, right); }
          break;
      }
    }
    // Chain cell segments into rings keyed on quantized endpoints.
    const key = (x: number, y: number) => Math.round(x * 100) + ":" + Math.round(y * 100);
    const touching = new Map<string, number[]>();
    segments.forEach((segment, index) => {
      for (const end of [0, 2]) {
        const k = key(segment[end]!, segment[end + 1]!);
        const list = touching.get(k);
        if (list) list.push(index); else touching.set(k, [index]);
      }
    });
    const used = new Array(segments.length).fill(false);
    for (let index = 0; index < segments.length; index++) {
      if (used[index]) continue;
      used[index] = true;
      const segment = segments[index]!;
      const chain: [number, number][] = [[segment[0]!, segment[1]!], [segment[2]!, segment[3]!]];
      for (const atTail of [true, false]) {
        for (;;) {
          const anchor = atTail ? chain[chain.length - 1]! : chain[0]!;
          const next = (touching.get(key(anchor[0], anchor[1])) ?? []).find(candidate => !used[candidate]);
          if (next === undefined) break;
          used[next] = true;
          const follow = segments[next]!;
          const other: [number, number] = key(follow[0]!, follow[1]!) === key(anchor[0], anchor[1]) ? [follow[2]!, follow[3]!] : [follow[0]!, follow[1]!];
          if (atTail) chain.push(other); else chain.unshift(other);
        }
      }
      const head = chain[0]!, tail = chain[chain.length - 1]!;
      const closed = chain.length > 3 && key(head[0], head[1]) === key(tail[0], tail[1]);
      if (closed) chain.pop();
      if (chain.length >= 2) rings.push({ band, closed, points: chain });
    }
    segments.length = 0;
  }
  return rings;
}

export function zoomGraphCamera(camera: GraphCamera, factor: number, anchor: { x: number; y: number }, width: number, height: number): GraphCamera {
  const scale = Math.max(0.5, Math.min(4, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { ...camera, scale,
    x: anchor.x - width / 2 - (anchor.x - width / 2 - (camera.x ?? 0)) * ratio,
    y: anchor.y - height / 2 - (anchor.y - height / 2 - (camera.y ?? 0)) * ratio,
  };
}
