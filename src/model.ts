// 业务模型:场地、节目脚本与"复制复用"的重算规则

export interface LaunchPosition {
  id: string;
  x: number; // 距场地左边界(m)
  y: number; // 距观众侧前缘(m)
}

export interface Venue {
  id: string;
  name: string;
  widthM: number;
  depthM: number;
  focusX: number; // 观众焦点 X
  focusY: number; // 观众焦点 Y(前缘外侧为负)
  burstHeightM: number; // 名义爆点高度
  minSpacingM: number; // 相邻点位建议最小间距
  curfewSec: number | null; // 硬性结束时刻(宵禁),null 表示不限
  positions: LaunchPosition[];
}

export interface Cue {
  id: string;
  segmentId: string;
  label: string;
  product: string;
  caliberMm: number;
  positionId: string; // 点位编号,复制时按编号对齐新场地
  angleDeg: number; // 发射角:相对竖直方向的倾角,偏向观众为正
  rangeM: number; // 爆开影响范围半径(m)
  fireAtSec: number; // 音乐锚点(复制时保持不变)
  durationSec: number;
  angleOffsetDeg: number; // 相对基准瞄准的偏移,重算时保留
  burstRadiusM: number; // 产品名义爆半径,重算时保留
}

export interface Segment {
  id: string;
  name: string;
  locked: boolean; // 已锁段落不参与自动改编
}

export interface ShowScript {
  id: string;
  name: string;
  venueId: string;
  durationSec: number; // 节目结束时刻
  version: number;
  segments: Segment[];
  cues: Cue[];
}

export interface VersionSnapshot {
  version: number;
  venueId: string;
  note: string;
  savedAt: string;
  script: ShowScript;
}

// 预置两套场地
export const VENUES: Venue[] = [
  {
    id: "riverside",
    name: "滨江会展中心",
    widthM: 120,
    depthM: 80,
    focusX: 60,
    focusY: -50,
    burstHeightM: 150,
    minSpacingM: 18,
    curfewSec: null,
    positions: [
      { id: "A1", x: 15, y: 52 },
      { id: "A2", x: 40, y: 46 },
      { id: "A3", x: 60, y: 42 },
      { id: "A4", x: 80, y: 46 },
      { id: "A5", x: 105, y: 52 },
      { id: "A6", x: 60, y: 16 },
    ],
  },
  {
    id: "lakeside",
    name: "湖畔露天剧场",
    widthM: 90,
    depthM: 60,
    focusX: 45,
    focusY: -30,
    burstHeightM: 110,
    minSpacingM: 12,
    curfewSec: 200,
    positions: [
      { id: "A1", x: 10, y: 44 },
      { id: "A2", x: 30, y: 38 },
      { id: "A3", x: 45, y: 32 },
      { id: "A4", x: 60, y: 38 },
      { id: "A5", x: 80, y: 44 },
    ],
  },
];

export function venueById(id: string): Venue {
  const venue = VENUES.find((v) => v.id === id);
  if (!venue) throw new Error(`未知场地:${id}`);
  return venue;
}

export function positionOf(venue: Venue, id: string): LaunchPosition | undefined {
  return venue.positions.find((p) => p.id === id);
}

export function nearestPositionId(venue: Venue, x: number, y: number): string {
  let best = venue.positions[0];
  let bestDist = Infinity;
  for (const p of venue.positions) {
    const d = dist2D(x, y, p.x, p.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best.id;
}

export function dist2D(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// 基准瞄准角:从点位指向观众焦点、相对竖直方向的倾角
export function baseAimDeg(pos: LaunchPosition, venue: Venue): number {
  const d = dist2D(pos.x, pos.y, venue.focusX, venue.focusY);
  return clamp(round1((Math.atan2(d, venue.burstHeightM) * 180) / Math.PI), 0, 40);
}

// 爆开影响范围:倾角越大,地面散布越广
export function rangeFromAim(burstRadiusM: number, aimDeg: number): number {
  return round1(burstRadiusM * (1 + aimDeg / 150));
}

// 按点位编号在新场地重算发射角与影响范围;点位缺失时返回 null,交由校验报越界
export function computeGeometry(
  positionId: string,
  venue: Venue,
  offsetDeg: number,
  burstRadiusM: number
): { angleDeg: number; rangeM: number } | null {
  const pos = positionOf(venue, positionId);
  if (!pos) return null;
  const angleDeg = clamp(round1(baseAimDeg(pos, venue) + offsetDeg), 0, 60);
  return { angleDeg, rangeM: rangeFromAim(burstRadiusM, angleDeg) };
}

export function segmentOf(script: ShowScript, segmentId: string): Segment | undefined {
  return script.segments.find((s) => s.id === segmentId);
}

// 节目有效结束时刻:脚本时长与场地宵禁取较早者
export function effectiveEndSec(script: ShowScript, venue: Venue): number {
  return venue.curfewSec == null ? script.durationSec : Math.min(script.durationSec, venue.curfewSec);
}

// 复制脚本到目标场地:未锁段落按点位编号重算角度与范围,音乐锚点不变,已锁段落原样保留
export function adaptScript(script: ShowScript, target: Venue): ShowScript {
  const cues = script.cues.map((cue) => {
    const seg = segmentOf(script, cue.segmentId);
    if (seg?.locked) return { ...cue };
    const geo = computeGeometry(cue.positionId, target, cue.angleOffsetDeg, cue.burstRadiusM);
    if (!geo) return { ...cue };
    return { ...cue, ...geo };
  });
  return { ...script, venueId: target.id, version: script.version + 1, cues };
}

export function snapshotOf(script: ShowScript, note: string): VersionSnapshot {
  return {
    version: script.version,
    venueId: script.venueId,
    note,
    savedAt: new Date().toISOString(),
    script: JSON.parse(JSON.stringify(script)) as ShowScript,
  };
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

// 预置一场三段节目(点火时刻即音乐锚点)
type CueSeed = Omit<Cue, "angleDeg" | "rangeM">;

const SEGMENTS: Segment[] = [
  { id: "s1", name: "序章·曙光", locked: false },
  { id: "s2", name: "副歌·奔流", locked: false },
  { id: "s3", name: "尾声·凯旋", locked: true },
];

const CUE_SEEDS: CueSeed[] = [
  { id: "c1", segmentId: "s1", label: "曙光·左扇形", product: "30mm扇形架·红", caliberMm: 30, positionId: "A1", angleOffsetDeg: -8, burstRadiusM: 10, fireAtSec: 12.5, durationSec: 4 },
  { id: "c2", segmentId: "s1", label: "曙光·右扇形", product: "30mm扇形架·蓝", caliberMm: 30, positionId: "A5", angleOffsetDeg: 8, burstRadiusM: 10, fireAtSec: 14, durationSec: 4 },
  { id: "c3", segmentId: "s1", label: "曙光·金冠", product: "75mm礼花弹·金", caliberMm: 75, positionId: "A3", angleOffsetDeg: 0, burstRadiusM: 14, fireAtSec: 30, durationSec: 3 },
  { id: "c4", segmentId: "s2", label: "奔流·银左", product: "75mm礼花弹·银", caliberMm: 75, positionId: "A2", angleOffsetDeg: -5, burstRadiusM: 15, fireAtSec: 68.2, durationSec: 3 },
  { id: "c5", segmentId: "s2", label: "奔流·银右", product: "75mm礼花弹·银", caliberMm: 75, positionId: "A4", angleOffsetDeg: 5, burstRadiusM: 15, fireAtSec: 68.2, durationSec: 3 },
  { id: "c6", segmentId: "s2", label: "奔流·紫心", product: "100mm礼花弹·紫", caliberMm: 100, positionId: "A3", angleOffsetDeg: 0, burstRadiusM: 18, fireAtSec: 95.5, durationSec: 4 },
  { id: "c7", segmentId: "s3", label: "凯旋·冷焰瀑布", product: "冷焰火·瀑布", caliberMm: 12, positionId: "A6", angleOffsetDeg: 0, burstRadiusM: 6, fireAtSec: 180, durationSec: 6 },
  { id: "c8", segmentId: "s3", label: "凯旋·金礼花", product: "75mm礼花弹·金", caliberMm: 75, positionId: "A6", angleOffsetDeg: 0, burstRadiusM: 15, fireAtSec: 196, durationSec: 8 },
];

export function buildInitialShow(): ShowScript {
  const venue = venueById("riverside");
  const cues = CUE_SEEDS.map((seed) => ({
    ...seed,
    ...computeGeometry(seed.positionId, venue, seed.angleOffsetDeg, seed.burstRadiusM)!,
  }));
  return {
    id: "show-jianghe",
    name: "《江河颂》巡演脚本",
    venueId: venue.id,
    durationSec: 240,
    version: 1,
    segments: SEGMENTS.map((s) => ({ ...s })),
    cues,
  };
}
