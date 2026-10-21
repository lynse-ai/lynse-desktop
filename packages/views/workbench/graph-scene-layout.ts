export interface GraphPoint { x: number; y: number; z: number }
export interface GraphCamera { yaw: number; pitch: number; scale: number }
export type GraphTopology = [string[], [string, string][]];

export const GRAPH_EDGE_LIMIT = 540;
export const DEFAULT_GRAPH_CAMERA: GraphCamera = { yaw: -0.3, pitch: -0.14, scale: 1 };

function initialPoint(id: string): GraphPoint {
  let seed = 2166136261;
  for (const character of id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return { x: (random() - 0.5) * 460, y: (random() - 0.5) * 290, z: (random() - 0.5) * 340 };
}

// Run only when visible topology changes, never as a continuous simulation.
export function layoutGraph([ids, links]: GraphTopology): Map<string, GraphPoint> {
  const points = new Map(ids.map(id => [id, initialPoint(id)]));
  if (ids.length === 1) { points.set(ids[0]!, { x: 0, y: 0, z: 0 }); return points; }
  for (let step = 0; step < 64; step++) {
    const deltas = new Map(ids.map(id => [id, { x: 0, y: 0, z: 0 }]));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = points.get(ids[i]!)!, b = points.get(ids[j]!)!;
      const dx = a.x - b.x || 0.1, dy = a.y - b.y || 0.1, dz = a.z - b.z || 0.1;
      const distance = Math.max(20, Math.hypot(dx, dy, dz));
      const force = Math.min(4, 2200 / (distance * distance));
      const da = deltas.get(ids[i]!)!, db = deltas.get(ids[j]!)!;
      da.x += dx / distance * force; da.y += dy / distance * force; da.z += dz / distance * force;
      db.x -= dx / distance * force; db.y -= dy / distance * force; db.z -= dz / distance * force;
    }
    for (const [source, target] of links) {
      const a = points.get(source)!, b = points.get(target)!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const force = (distance - 120) * 0.012;
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
    const x = p.x * cosYaw + p.z * sinYaw;
    const z = -p.x * sinYaw + p.z * cosYaw;
    const y = p.y * cosPitch - z * sinPitch;
    const depth = p.y * sinPitch + z * cosPitch;
    const perspective = 850 / (850 - depth);
    return { id, x: x * perspective, y: y * perspective, depth, perspective };
  });
  // A stable scene radius prevents the camera from stretching during rotation.
  const radius = Math.max(100, ...[...points.values()].map(p => Math.hypot(p.x, p.y, p.z)));
  const projectedRadius = radius / Math.sqrt(1 - (radius / 850) ** 2);
  const fit = Math.min(Math.max(1, width - 56), Math.max(1, height - 72)) / (projectedRadius * 2) * camera.scale;
  return new Map(raw.map(p => [p.id, {
    x: width / 2 + p.x * fit,
    y: height / 2 - p.y * fit,
    depth: p.depth,
    size: Math.max(0.65, Math.min(1.7, p.perspective)),
    opacity: Math.max(0.3, Math.min(1, 0.7 + p.depth / 700)),
  }]));
}
