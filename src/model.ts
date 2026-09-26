/**
 * 业务模型：场地、节目、段落、点火节点，以及"换场地复用脚本"的改编规则。
 * 校验逻辑见 validate.ts，页面见 App.tsx。
 */

export interface Vec {
  x: number;
  y: number;
}

/** 燃放点位（场地平面图上的编号点） */
export interface VenuePoint extends Vec {
  no: number;
}

/** 场地：边界尺寸、观众锚点、宵禁时刻与点位表 */
export interface Venue {
  id: string;
  name: string;
  width: number; // 场地宽（m）
  depth: number; // 场地纵深（m）
  aim: Vec; // 观众锚点，发射角瞄准它
  curfewS?: number; // 场地宵禁（秒），节点不得晚于它结束
  points: VenuePoint[];
}

/** 点火节点：音乐锚点时刻 + 弹道参数 */
export interface Shot {
  id: string;
  pointNo: number; // 点位编号（换场地后按编号对齐新点）
  product: string; // 烟花型号
  caliberMm: number; // 口径
  angleDeg: number; // 发射角（平面方位角，随点位校正）
  burstRadiusM: number; // 爆开影响半径（m，随点位距离校正）
  anchorS: number; // 音乐锚点时刻（秒，换场地不变）
  durationS: number; // 持续时间（秒）
}

/** 节目段落；锁定的段落在复制时不自动改编 */
export interface Segment {
  id: string;
  name: string;
  locked: boolean;
  shots: Shot[];
}

export interface Show {
  id: string;
  name: string;
  endTimeS: number; // 节目结束时刻（秒）
  segments: Segment[];
}

/** 已提交的版本：某份脚本在某套场地上的快照 */
export interface Version {
  id: string;
  label: string;
  venueId: string;
  show: Show;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// 几何与重算
// ---------------------------------------------------------------------------

export const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 平面方位角（未归一化）：0° 指向 +x，调用方用 norm360 归一化到 [0, 360) */
export const bearingDeg = (from: Vec, to: Vec): number =>
  (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

const round1 = (v: number): number => Math.round(v * 10) / 10;

export const findPoint = (venue: Venue, no: number): VenuePoint | undefined =>
  venue.points.find((p) => p.no === no);

/**
 * 按编号重算单个节点：在新场地里找到同编号点位，
 * 发射角改为指向新场地观众锚点，爆开范围按"到锚点距离"等比缩放。
 * 新场地缺少该编号点位时保持原值，交给校验报"越界"。
 */
export function recomputeShot(shot: Shot, from: Venue, to: Venue): Shot {
  const oldPoint = findPoint(from, shot.pointNo);
  const newPoint = findPoint(to, shot.pointNo);
  if (!oldPoint || !newPoint) return { ...shot };
  const ratio = distance(newPoint, to.aim) / distance(oldPoint, from.aim);
  return {
    ...shot,
    angleDeg: round1(norm360(bearingDeg(newPoint, to.aim))),
    burstRadiusM: round1(shot.burstRadiusM * ratio),
  };
}

/**
 * 复制脚本到目标场地：未锁定段落逐节点重算，已锁定段落原样保留，
 * 音乐锚点时刻一律不变。
 */
export function adaptShowToVenue(show: Show, from: Venue, to: Venue): Show {
  return {
    ...show,
    segments: show.segments.map((seg) =>
      seg.locked
        ? { ...seg, shots: seg.shots.map((s) => ({ ...s })) }
        : { ...seg, shots: seg.shots.map((s) => recomputeShot(s, from, to)) }
    ),
  };
}

/** 节目有效结束时刻：节目结束与场地宵禁取更早者 */
export const effectiveEndS = (show: Show, venue: Venue): number =>
  venue.curfewS === undefined ? show.endTimeS : Math.min(show.endTimeS, venue.curfewS);

export interface FlatShot extends Shot {
  segmentId: string;
  segmentName: string;
  segmentLocked: boolean;
}

/** 按音乐锚点时刻升序拍平全部节点 */
export function allShots(show: Show): FlatShot[] {
  return show.segments
    .flatMap((seg) =>
      seg.shots.map((s) => ({
        ...s,
        segmentId: seg.id,
        segmentName: seg.name,
        segmentLocked: seg.locked,
      }))
    )
    .sort((a, b) => a.anchorS - b.anchorS);
}

export const shotEndS = (shot: Shot): number => shot.anchorS + shot.durationS;

/** 秒 → "mm:ss.d" */
export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// 预置数据：两套场地 + 一场三段节目（终章已锁定）
// ---------------------------------------------------------------------------

export const VENUES: Venue[] = [
  {
    id: "riverside",
    name: "滨江剧场（原场地）",
    width: 120,
    depth: 80,
    aim: { x: 60, y: -30 },
    points: [
      { no: 1, x: 15, y: 58 },
      { no: 2, x: 38, y: 66 },
      { no: 3, x: 60, y: 50 },
      { no: 4, x: 82, y: 66 },
      { no: 5, x: 106, y: 54 },
      { no: 6, x: 60, y: 72 },
    ],
  },
  {
    id: "lakeside",
    name: "湖畔巡演场（目标场地）",
    width: 100,
    depth: 70,
    aim: { x: 45, y: -25 },
    curfewS: 230, // 巡演场 23:50 宵禁，节目有效结束提前
    points: [
      { no: 1, x: 12, y: 48 },
      { no: 2, x: 36, y: 54 },
      { no: 3, x: 45, y: 26 },
      { no: 4, x: 54, y: 54 },
      { no: 5, x: 82, y: 46 },
    ],
  },
];

export const SOURCE_SHOW: Show = {
  id: "tour-galaxy",
  name: "巡演标准场《星河》",
  endTimeS: 240,
  segments: [
    {
      id: "intro",
      name: "序章·开场",
      locked: false,
      shots: [
        { id: "s1", pointNo: 1, product: "30mm扇形架", caliberMm: 30, angleDeg: 297.1, burstRadiusM: 12, anchorS: 12.5, durationS: 4 },
        { id: "s2", pointNo: 3, product: "50mm罗马烛光", caliberMm: 50, angleDeg: 270.0, burstRadiusM: 10, anchorS: 38.0, durationS: 6 },
      ],
    },
    {
      id: "main",
      name: "主秀·星河",
      locked: false,
      shots: [
        { id: "s3", pointNo: 2, product: "75mm礼花弹", caliberMm: 75, angleDeg: 282.9, burstRadiusM: 14, anchorS: 68.2, durationS: 5 },
        { id: "s4", pointNo: 4, product: "75mm礼花弹", caliberMm: 75, angleDeg: 257.1, burstRadiusM: 12, anchorS: 96.0, durationS: 5 },
        { id: "s5", pointNo: 5, product: "100mm礼花弹", caliberMm: 100, angleDeg: 241.3, burstRadiusM: 14, anchorS: 128.0, durationS: 6 },
      ],
    },
    {
      id: "finale",
      name: "终章·谢幕",
      locked: true, // 已锁段落：复制时不自动改编
      shots: [
        { id: "s6", pointNo: 6, product: "冷焰火", caliberMm: 30, angleDeg: 270.0, burstRadiusM: 5, anchorS: 200.0, durationS: 8 },
        { id: "s7", pointNo: 3, product: "45mm组合盆花", caliberMm: 45, angleDeg: 270.0, burstRadiusM: 14, anchorS: 222.0, durationS: 10 },
      ],
    },
  ],
};

export const SEGMENT_COLORS: Record<string, string> = {
  intro: "#1d4ed8",
  main: "#dc2626",
  finale: "#f59e0b",
};
