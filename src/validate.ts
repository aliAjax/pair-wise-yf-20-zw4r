/**
 * 校验：把脚本切换到新场地前的三类冲突检查。
 * 任一冲突存在都必须停止切换，修好再提交。
 *   1. 新点越界——点位编号在新场地不存在，或爆开范围超出场地边界；
 *   2. 相邻范围相交——时间轴上相邻两节点的爆开圆相交；
 *   3. 越过节目结束——节点结束时刻晚于节目有效结束（含场地宵禁）。
 */

import {
  allShots,
  distance,
  effectiveEndS,
  findPoint,
  fmtTime,
  shotEndS,
  type FlatShot,
  type Show,
  type Venue,
} from "./model";

export type ConflictKind = "out-of-bounds" | "overlap" | "past-end";

export interface Conflict {
  kind: ConflictKind;
  shotIds: string[];
  message: string;
}

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  "out-of-bounds": "新点越界",
  overlap: "相邻范围相交",
  "past-end": "越过节目结束",
};

const EPS = 1e-6;

function checkOutOfBounds(shots: FlatShot[], venue: Venue): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const shot of shots) {
    const point = findPoint(venue, shot.pointNo);
    if (!point) {
      conflicts.push({
        kind: "out-of-bounds",
        shotIds: [shot.id],
        message: `「${shot.segmentName}」${shot.product} 使用的 ${shot.pointNo} 号点位在「${venue.name}」不存在，新点越界`,
      });
      continue;
    }
    const r = shot.burstRadiusM;
    if (
      point.x - r < -EPS ||
      point.x + r > venue.width + EPS ||
      point.y - r < -EPS ||
      point.y + r > venue.depth + EPS
    ) {
      conflicts.push({
        kind: "out-of-bounds",
        shotIds: [shot.id],
        message: `「${shot.segmentName}」${shot.product}（${shot.pointNo} 号点）爆开范围 ${r}m 超出场地边界 ${venue.width}×${venue.depth}m`,
      });
    }
  }
  return conflicts;
}

function checkOverlap(shots: FlatShot[], venue: Venue): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let i = 0; i < shots.length - 1; i += 1) {
    const a = shots[i];
    const b = shots[i + 1];
    const pa = findPoint(venue, a.pointNo);
    const pb = findPoint(venue, b.pointNo);
    if (!pa || !pb) continue; // 缺点的节点已由越界检查报告
    const gap = distance(pa, pb) - (a.burstRadiusM + b.burstRadiusM);
    if (gap < -EPS) {
      conflicts.push({
        kind: "overlap",
        shotIds: [a.id, b.id],
        message: `相邻节点 ${fmtTime(a.anchorS)}「${a.product}」与 ${fmtTime(b.anchorS)}「${b.product}」影响范围相交（间距不足 ${Math.abs(gap).toFixed(1)}m）`,
      });
    }
  }
  return conflicts;
}

function checkPastEnd(shots: FlatShot[], show: Show, venue: Venue): Conflict[] {
  const end = effectiveEndS(show, venue);
  return shots
    .filter((shot) => shotEndS(shot) > end + EPS)
    .map((shot) => ({
      kind: "past-end" as const,
      shotIds: [shot.id],
      message: `「${shot.segmentName}」${shot.product} 于 ${fmtTime(shotEndS(shot))} 才结束，越过节目有效结束 ${fmtTime(end)}${
        venue.curfewS !== undefined && venue.curfewS < show.endTimeS ? "（受场地宵禁限制）" : ""
      }`,
    }));
}

/** 对"某份脚本 + 某套场地"做全量校验，返回全部冲突 */
export function validateShowOnVenue(show: Show, venue: Venue): Conflict[] {
  const shots = allShots(show);
  return [
    ...checkOutOfBounds(shots, venue),
    ...checkOverlap(shots, venue),
    ...checkPastEnd(shots, show, venue),
  ];
}

/** 冲突涉及的节点 id 集合，供时间轴 / 点位图 / 编辑表高亮 */
export function conflictShotIds(conflicts: Conflict[]): Set<string> {
  return new Set(conflicts.flatMap((c) => c.shotIds));
}
