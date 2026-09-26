// 校验:复用候选脚本在目标场地上的冲突检测
import type { Cue, ShowScript, Venue } from "./model";
import { dist2D, effectiveEndSec, formatClock, positionOf, round1 } from "./model";

export type ConflictKind = "OUT_OF_BOUNDS" | "RANGE_OVERLAP" | "PAST_SHOW_END";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  cueIds: string[];
  segmentId: string;
  title: string;
  detail: string;
}

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  OUT_OF_BOUNDS: "新点越界",
  RANGE_OVERLAP: "相邻范围相交",
  PAST_SHOW_END: "越过节目结束",
};

export function validateScript(script: ShowScript, venue: Venue): Conflict[] {
  const conflicts: Conflict[] = [];

  // 1) 新点越界:点位编号在目标场地不存在,或坐标落在场地边界外
  for (const cue of script.cues) {
    const pos = positionOf(venue, cue.positionId);
    if (!pos) {
      conflicts.push({
        id: `OOB:${cue.id}`,
        kind: "OUT_OF_BOUNDS",
        cueIds: [cue.id],
        segmentId: cue.segmentId,
        title: `${cue.label} 的点位 ${cue.positionId} 在「${venue.name}」不存在`,
        detail: "按编号对齐失败,请为该节点重新指定点位后再提交。",
      });
    } else if (pos.x < 0 || pos.x > venue.widthM || pos.y < 0 || pos.y > venue.depthM) {
      conflicts.push({
        id: `OOB:${cue.id}`,
        kind: "OUT_OF_BOUNDS",
        cueIds: [cue.id],
        segmentId: cue.segmentId,
        title: `${cue.label} 的点位 ${cue.positionId} 超出「${venue.name}」边界`,
        detail: `坐标 (${pos.x}, ${pos.y}) 不在 ${venue.widthM}m × ${venue.depthM}m 场地范围内。`,
      });
    }
  }

  // 2) 相邻范围相交:点火时间窗重叠的节点,爆开影响范围不得相交
  const byTime = [...script.cues].sort((a, b) => a.fireAtSec - b.fireAtSec);
  for (let i = 0; i < byTime.length; i++) {
    const a: Cue = byTime[i];
    const aEnd = a.fireAtSec + a.durationSec;
    for (let j = i + 1; j < byTime.length; j++) {
      const b: Cue = byTime[j];
      if (b.fireAtSec >= aEnd) break; // 之后节点更晚,不会再与 a 同时燃放
      const pa = positionOf(venue, a.positionId);
      const pb = positionOf(venue, b.positionId);
      if (!pa || !pb) continue; // 越界已由上面单独报告
      const d = dist2D(pa.x, pa.y, pb.x, pb.y);
      const sum = round1(a.rangeM + b.rangeM);
      if (d < sum) {
        conflicts.push({
          id: `OVL:${a.id}+${b.id}`,
          kind: "RANGE_OVERLAP",
          cueIds: [a.id, b.id],
          segmentId: a.segmentId,
          title: `${a.label} 与 ${b.label} 的影响范围相交`,
          detail: `相邻点位 ${a.positionId}↔${b.positionId} 间距 ${round1(d)}m,小于范围之和 ${sum}m。`,
        });
      }
    }
  }

  // 3) 后续节点越过节目结束(含场地宵禁)
  const end = effectiveEndSec(script, venue);
  for (const cue of script.cues) {
    const cueEnd = round1(cue.fireAtSec + cue.durationSec);
    if (cueEnd > end) {
      conflicts.push({
        id: `END:${cue.id}`,
        kind: "PAST_SHOW_END",
        cueIds: [cue.id],
        segmentId: cue.segmentId,
        title: `${cue.label} 越过节目结束`,
        detail: `节点结束于 ${formatClock(cueEnd)},节目结束为 ${formatClock(end)}${venue.curfewSec != null ? "(含场地宵禁)" : ""}。`,
      });
    }
  }

  const order: ConflictKind[] = ["OUT_OF_BOUNDS", "RANGE_OVERLAP", "PAST_SHOW_END"];
  return conflicts.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
}
