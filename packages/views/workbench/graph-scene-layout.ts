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
  const minX = Math.min(...raw.map(p => p.x)), maxX = Math.max(...raw.map(p => p.x));
  const minY = Math.min(...raw.map(p => p.y)), maxY = Math.max(...raw.map(p => p.y));
  // Fit the actual cloud to the rectangular viewport instead of an enclosing sphere.
  const fit = Math.min(Math.max(1, width * 0.84) / Math.max(140, maxX - minX), Math.max(1, height * 0.84) / Math.max(140, maxY - minY)) * camera.scale;
  return new Map(raw.map(p => [p.id, {
    x: width / 2 + (p.x - (minX + maxX) / 2) * fit + (camera.x ?? 0),
    y: height / 2 - (p.y - (minY + maxY) / 2) * fit + (camera.y ?? 0),
    depth: p.depth,
    size: Math.max(0.5, Math.min(1.7, p.perspective)),
    opacity: camera.mode === "2d" ? 1 : Math.max(0.5, Math.min(1, 0.8 + p.depth / 840)),
  }]));
}

export function zoomGraphCamera(camera: GraphCamera, factor: number, anchor: { x: number; y: number }, width: number, height: number): GraphCamera {
  const scale = Math.max(0.5, Math.min(4, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { ...camera, scale,
    x: anchor.x - width / 2 - (anchor.x - width / 2 - (camera.x ?? 0)) * ratio,
    y: anchor.y - height / 2 - (anchor.y - height / 2 - (camera.y ?? 0)) * ratio,
  };
}
