import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import type { Cue, ShowScript, Venue, VersionSnapshot } from "./model";
import {
  VENUES,
  adaptScript,
  buildInitialShow,
  computeGeometry,
  dist2D,
  effectiveEndSec,
  formatClock,
  nearestPositionId,
  positionOf,
  round1,
  segmentOf,
  snapshotOf,
  venueById,
} from "./model";
import type { Conflict, ConflictKind } from "./validate";
import { CONFLICT_KIND_LABEL, validateScript } from "./validate";

const SEGMENT_COLORS: Record<string, string> = {
  s1: "#1d4ed8",
  s2: "#f59e0b",
  s3: "#dc2626",
};

const STORAGE_KEY = "hxyfront-62008:reuse-workspace";

interface DraftState {
  targetVenueId: string;
  candidate: ShowScript;
}

interface WorkspaceState {
  currentVenueId: string;
  script: ShowScript;
  versions: VersionSnapshot[];
  draft: DraftState | null;
}

function initialWorkspace(): WorkspaceState {
  const script = buildInitialShow();
  return {
    currentVenueId: script.venueId,
    script,
    versions: [snapshotOf(script, "初始脚本 · 滨江会展中心首演版")],
    draft: null,
  };
}

function loadWorkspace(): WorkspaceState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed.script || !Array.isArray(parsed.versions) || parsed.versions.length === 0) return null;
    return { ...parsed, draft: parsed.draft ?? null };
  } catch {
    return null;
  }
}

const QUICK_FIX_LABEL: Record<ConflictKind, string> = {
  OUT_OF_BOUNDS: "映射到最近点位",
  RANGE_OVERLAP: "双方向内收敛",
  PAST_SHOW_END: "压缩至节目结束",
};

function App() {
  const [ws, setWs] = useState<WorkspaceState>(() => loadWorkspace() ?? initialWorkspace());
  const [savedAt, setSavedAt] = useState("—");
  const [notice, setNotice] = useState<string | null>(null);

  // 草稿同步保存:任何工作区变化立即落盘
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ws));
    setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
  }, [ws]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 有待提交的复用草稿时,时间轴/点位图/校验一律预演草稿
  const viewScript = ws.draft ? ws.draft.candidate : ws.script;
  const viewVenue = venueById(ws.draft ? ws.draft.targetVenueId : ws.currentVenueId);
  const conflicts = useMemo(() => validateScript(viewScript, viewVenue), [viewScript, viewVenue]);
  const conflictCueIds = useMemo(() => new Set(conflicts.flatMap((c) => c.cueIds)), [conflicts]);
  const endSec = effectiveEndSec(viewScript, viewVenue);

  function patchDraftCue(cueId: string, patch: Partial<Cue>) {
    setWs((prev) => {
      if (!prev.draft) return prev;
      const target = venueById(prev.draft.targetVenueId);
      const cues = prev.draft.candidate.cues.map((cue) => {
        if (cue.id !== cueId) return cue;
        let next = { ...cue, ...patch };
        if (patch.positionId) {
          // 手动改点位同样按新坐标重算角度与范围(锁定段落也允许手动修)
          const geo = computeGeometry(patch.positionId, target, next.angleOffsetDeg, next.burstRadiusM);
          if (geo) next = { ...next, ...geo };
        }
        return next;
      });
      return { ...prev, draft: { ...prev.draft, candidate: { ...prev.draft.candidate, cues } } };
    });
  }

  function quickFix(conflict: Conflict) {
    const draft = ws.draft;
    if (!draft) return;
    const target = venueById(draft.targetVenueId);

    if (conflict.kind === "OUT_OF_BOUNDS") {
      const cue = draft.candidate.cues.find((c) => c.id === conflict.cueIds[0]);
      if (!cue) return;
      const srcVenue = venueById(ws.script.venueId);
      const srcPos = positionOf(srcVenue, cue.positionId);
      const nx = srcPos ? (srcPos.x / srcVenue.widthM) * target.widthM : target.widthM / 2;
      const ny = srcPos ? (srcPos.y / srcVenue.depthM) * target.depthM : target.depthM / 2;
      patchDraftCue(cue.id, { positionId: nearestPositionId(target, nx, ny) });
      return;
    }

    if (conflict.kind === "RANGE_OVERLAP") {
      const [a, b] = conflict.cueIds.map((id) => draft.candidate.cues.find((c) => c.id === id));
      if (!a || !b) return;
      const pa = positionOf(target, a.positionId);
      const pb = positionOf(target, b.positionId);
      if (!pa || !pb) return;
      const fit = round1(Math.max(1, (dist2D(pa.x, pa.y, pb.x, pb.y) - 0.4) / 2));
      patchDraftCue(a.id, { rangeM: fit });
      patchDraftCue(b.id, { rangeM: fit });
      return;
    }

    const cue = draft.candidate.cues.find((c) => c.id === conflict.cueIds[0]);
    if (!cue) return;
    const end = effectiveEndSec(draft.candidate, target);
    patchDraftCue(cue.id, { durationSec: round1(Math.max(0.5, end - cue.fireAtSec)) });
  }

  function commit(candidate: ShowScript, note: string) {
    setWs((prev) => ({
      currentVenueId: candidate.venueId,
      script: candidate,
      versions: [...prev.versions, snapshotOf(candidate, note)],
      draft: null,
    }));
  }

  function startReuse(targetVenueId: string) {
    const target = venueById(targetVenueId);
    const candidate = adaptScript(ws.script, target);
    const found = validateScript(candidate, target);
    if (found.length === 0) {
      commit(candidate, `复用到「${target.name}」· 无冲突直接切换`);
      setNotice(`已切换到「${target.name}」,校验通过,版本 v${candidate.version}。`);
    } else {
      setWs((prev) => ({ ...prev, draft: { targetVenueId, candidate } }));
      setNotice(`已停止切换:${found.length} 项冲突待处理,修好再提交。`);
    }
  }

  function submitDraft() {
    if (!ws.draft) return;
    const target = venueById(ws.draft.targetVenueId);
    const found = validateScript(ws.draft.candidate, target);
    if (found.length > 0) {
      setNotice(`仍有 ${found.length} 项冲突,继续修改后再提交。`);
      return;
    }
    const version = ws.draft.candidate.version;
    commit(ws.draft.candidate, `复用到「${target.name}」· 修复冲突后提交`);
    setNotice(`冲突已清零,已切换到「${target.name}」,版本 v${version}。`);
  }

  function discardDraft() {
    setWs((prev) => ({ ...prev, draft: null }));
    setNotice("已放弃复用草稿,保持当前场地。");
  }

  const metrics: Array<[string, string]> = [
    ["节目段落", String(viewScript.segments.length)],
    ["点火节点", String(viewScript.cues.length)],
    ["冲突提示", String(conflicts.length)],
    ["脚本版本", `v${ws.script.version}`],
  ];

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 巡演脚本场地复用台 · Port 62008</p>
        <h1>{ws.script.name}</h1>
        <span>
          换场地复用旧脚本:复制后按点位编号重算发射角与爆开影响范围,音乐锚点时刻保持不变,已锁段落不自动改编。
          若新点越界、相邻范围相交或后续节点越过节目结束,将停止切换并列出冲突,修好再提交。
        </span>
        <div className="hero-meta">
          <span>当前场地:{venueById(ws.currentVenueId).name}</span>
          <span>脚本版本:v{ws.script.version}</span>
          <span>草稿已同步 {savedAt}</span>
        </div>
      </section>

      <section className="metrics">
        {metrics.map(([label, value]) => (
          <article key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>场地复用</p>
            <h2>选择目标场地并复制脚本</h2>
          </div>
          <span className="save-state">草稿同步保存 · {savedAt}</span>
        </div>
        <div className="venue-grid">
          {VENUES.map((venue) => {
            const isCurrent = venue.id === ws.currentVenueId;
            const isTarget = ws.draft?.targetVenueId === venue.id;
            return (
              <article
                key={venue.id}
                className={`venue-card${isCurrent ? " current" : ""}${isTarget ? " target" : ""}`}
              >
                <header>
                  <h3>{venue.name}</h3>
                  {isCurrent && <span className="badge">当前场地</span>}
                  {isTarget && <span className="badge warn">复用目标 · 草稿</span>}
                </header>
                <p>
                  {venue.widthM}m × {venue.depthM}m · {venue.positions.length} 个点位 · 爆高{" "}
                  {venue.burstHeightM}m
                  {venue.curfewSec != null ? ` · 宵禁 ${formatClock(venue.curfewSec)}` : " · 无宵禁"}
                </p>
                <p>点位编号:{venue.positions.map((p) => p.id).join(" / ")}</p>
                {!isCurrent && (
                  <button className="primary" onClick={() => startReuse(venue.id)}>
                    {isTarget ? "重新生成复用草稿" : "复制脚本到此场地"}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {notice && <div className="notice">{notice}</div>}

      {ws.draft && (
        <section className="panel conflict-panel">
          <div className="heading">
            <div>
              <p>切换已停止</p>
              <h2>复用草稿 → {venueById(ws.draft.targetVenueId).name}</h2>
            </div>
            <div className="actions">
              <button onClick={discardDraft}>放弃草稿</button>
              <button className="primary" disabled={conflicts.length > 0} onClick={submitDraft}>
                {conflicts.length > 0 ? `还有 ${conflicts.length} 项冲突` : "提交切换"}
              </button>
            </div>
          </div>
          <p className="hint">
            已按点位编号重算发射角与爆开范围,音乐锚点时刻不变;已锁段落未自动改编,可在下表手动修正。全部冲突清零后才能提交。
          </p>
          {conflicts.length > 0 ? (
            <ul className="conflict-list">
              {conflicts.map((conflict) => (
                <li key={conflict.id} className="conflict">
                  <span className={`kind kind-${conflict.kind}`}>{CONFLICT_KIND_LABEL[conflict.kind]}</span>
                  <div>
                    <b>{conflict.title}</b>
                    <p>{conflict.detail}</p>
                  </div>
                  <button onClick={() => quickFix(conflict)}>{QUICK_FIX_LABEL[conflict.kind]}</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ok">✔ 冲突已清零,可以提交切换。</p>
          )}
          <DraftTable
            draft={ws.draft}
            conflictCueIds={conflictCueIds}
            onPatch={patchDraftCue}
          />
        </section>
      )}

      <section className="panel">
        <div className="heading">
          <div>
            <p>时间轴</p>
            <h2>
              {ws.draft ? "草稿预演" : "当前脚本"} · 全长 {formatClock(viewScript.durationSec)}
            </h2>
          </div>
          <span className="hint-inline">
            音乐锚点时刻不变 · 节目结束 {formatClock(endSec)}
            {viewVenue.curfewSec != null ? "(含宵禁)" : ""}
          </span>
        </div>
        <Timeline script={viewScript} venue={viewVenue} conflictCueIds={conflictCueIds} />
        <p className="hint">🔒 = 已锁段落 · 红框 = 冲突节点 · 红色竖线 = 场地宵禁</p>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="heading">
            <div>
              <p>点位平面图</p>
              <h2>
                {viewVenue.name}
                {ws.draft ? "(草稿预演)" : ""}
              </h2>
            </div>
          </div>
          <SiteMap venue={viewVenue} script={viewScript} conflictCueIds={conflictCueIds} />
        </div>
        <div className="panel">
          <div className="heading">
            <div>
              <p>版本对照</p>
              <h2>复用前后逐节点比对</h2>
            </div>
          </div>
          <VersionCompare versions={ws.versions} />
        </div>
      </section>
    </main>
  );
}

function DraftTable({
  draft,
  conflictCueIds,
  onPatch,
}: {
  draft: DraftState;
  conflictCueIds: Set<string>;
  onPatch: (cueId: string, patch: Partial<Cue>) => void;
}) {
  const target = venueById(draft.targetVenueId);
  const numberPatch =
    (cueId: string, key: keyof Cue) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) onPatch(cueId, { [key]: n } as Partial<Cue>);
    };

  return (
    <div className="table-wrap">
      <table className="cue-table">
        <thead>
          <tr>
            <th>节点</th>
            <th>段落</th>
            <th>点位</th>
            <th>发射角°</th>
            <th>范围m</th>
            <th>音乐锚点s</th>
            <th>时长s</th>
          </tr>
        </thead>
        <tbody>
          {draft.candidate.cues.map((cue) => {
            const seg = segmentOf(draft.candidate, cue.segmentId);
            const missing = !positionOf(target, cue.positionId);
            return (
              <tr key={cue.id} className={conflictCueIds.has(cue.id) ? "bad" : ""}>
                <td>
                  <b>{cue.label}</b>
                  <small>
                    {cue.product} · {cue.caliberMm}mm
                  </small>
                </td>
                <td>
                  {seg?.locked ? "🔒 " : ""}
                  {seg?.name}
                </td>
                <td>
                  <select
                    value={cue.positionId}
                    className={missing ? "missing" : ""}
                    onChange={(e) => onPatch(cue.id, { positionId: e.target.value })}
                  >
                    {missing && <option value={cue.positionId}>{cue.positionId}(缺失)</option>}
                    {target.positions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="number" step="0.1" value={cue.angleDeg} onChange={numberPatch(cue.id, "angleDeg")} />
                </td>
                <td>
                  <input type="number" step="0.1" value={cue.rangeM} onChange={numberPatch(cue.id, "rangeM")} />
                </td>
                <td>
                  <input type="number" step="0.1" value={cue.fireAtSec} onChange={numberPatch(cue.id, "fireAtSec")} />
                </td>
                <td>
                  <input type="number" step="0.1" value={cue.durationSec} onChange={numberPatch(cue.id, "durationSec")} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({
  script,
  venue,
  conflictCueIds,
}: {
  script: ShowScript;
  venue: Venue;
  conflictCueIds: Set<string>;
}) {
  const total = script.durationSec;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += 30) ticks.push(t);

  return (
    <div className="timeline">
      <div className="ruler">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${(t / total) * 100}%` }}>
            {formatClock(t)}
          </span>
        ))}
      </div>
      {script.segments.map((seg) => (
        <div key={seg.id} className={`lane${seg.locked ? " locked" : ""}`}>
          <div className="lane-label">
            {seg.locked ? "🔒 " : ""}
            {seg.name}
          </div>
          <div className="lane-track">
            {script.cues
              .filter((cue) => cue.segmentId === seg.id)
              .map((cue) => (
                <div
                  key={cue.id}
                  className={`cue-block${conflictCueIds.has(cue.id) ? " conflict" : ""}`}
                  style={{
                    left: `${(cue.fireAtSec / total) * 100}%`,
                    width: `${Math.max((cue.durationSec / total) * 100, 1.4)}%`,
                    background: SEGMENT_COLORS[seg.id] ?? "#1d4ed8",
                  }}
                  title={`${cue.product} · 点位 ${cue.positionId} · ${cue.angleDeg}° · 范围 ${cue.rangeM}m · 锚点 ${formatClock(cue.fireAtSec)}`}
                >
                  {cue.label}
                </div>
              ))}
            {venue.curfewSec != null && venue.curfewSec < total && (
              <i className="curfew" style={{ left: `${(venue.curfewSec / total) * 100}%` }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SiteMap({
  venue,
  script,
  conflictCueIds,
}: {
  venue: Venue;
  script: ShowScript;
  conflictCueIds: Set<string>;
}) {
  const W = venue.widthM;
  const D = venue.depthM;
  const margin = 14;
  const audiencePad = Math.abs(Math.min(0, venue.focusY)) + 16;
  const sy = (y: number) => D - y; // 观众侧前缘(y=0)画在底部
  const missing = script.cues.filter((cue) => !positionOf(venue, cue.positionId));

  return (
    <div className="sitemap">
      <svg viewBox={`${-margin} ${-margin} ${W + margin * 2} ${D + margin + audiencePad}`} role="img">
        <rect x={0} y={0} width={W} height={D} className="ground" rx={2} />
        <line
          x1={-margin / 2}
          x2={W + margin / 2}
          y1={sy(venue.focusY)}
          y2={sy(venue.focusY)}
          className="audience-line"
        />
        <circle cx={venue.focusX} cy={sy(venue.focusY)} r={1.8} className="focus" />
        <text x={W / 2} y={sy(venue.focusY) + 9} textAnchor="middle" className="audience-text">
          观众区 · 焦点
        </text>
        {script.cues.map((cue) => {
          const pos = positionOf(venue, cue.positionId);
          if (!pos) return null;
          const color = SEGMENT_COLORS[cue.segmentId] ?? "#1d4ed8";
          const bad = conflictCueIds.has(cue.id);
          return (
            <circle
              key={cue.id}
              cx={pos.x}
              cy={sy(pos.y)}
              r={cue.rangeM}
              fill={color}
              fillOpacity={bad ? 0.22 : 0.1}
              stroke={bad ? "#dc2626" : color}
              strokeWidth={bad ? 0.9 : 0.45}
              strokeDasharray={bad ? "2 1.6" : undefined}
            />
          );
        })}
        {venue.positions.map((p) => (
          <g key={p.id}>
            <circle cx={p.x} cy={sy(p.y)} r={2.1} className="pos" />
            <text x={p.x} y={sy(p.y) - 3.6} textAnchor="middle" className="pos-label">
              {p.id}
            </text>
          </g>
        ))}
      </svg>
      {missing.length > 0 && (
        <p className="warn-text">⚠ 未落点:{missing.map((c) => `${c.label}(${c.positionId})`).join("、")}</p>
      )}
      <p className="hint">圆环为各节点爆开影响范围;红色虚线为冲突节点。</p>
    </div>
  );
}

const DIFF_FIELDS: Array<{ label: string; read: (cue: Cue) => string }> = [
  { label: "点位", read: (c) => c.positionId },
  { label: "发射角", read: (c) => `${c.angleDeg}°` },
  { label: "范围", read: (c) => `${c.rangeM}m` },
  { label: "锚点", read: (c) => formatClock(c.fireAtSec) },
  { label: "时长", read: (c) => `${c.durationSec}s` },
];

function VersionCompare({ versions }: { versions: VersionSnapshot[] }) {
  const [aVer, setAVer] = useState(versions[0]?.version ?? 1);
  const [bVer, setBVer] = useState(versions[versions.length - 1]?.version ?? 1);

  useEffect(() => {
    if (!versions.some((v) => v.version === aVer)) setAVer(versions[0].version);
    if (!versions.some((v) => v.version === bVer)) setBVer(versions[versions.length - 1].version);
  }, [versions, aVer, bVer]);

  const a = versions.find((v) => v.version === aVer) ?? versions[0];
  const b = versions.find((v) => v.version === bVer) ?? versions[versions.length - 1];

  const cueIds: string[] = [];
  for (const cue of [...b.script.cues, ...a.script.cues]) {
    if (!cueIds.includes(cue.id)) cueIds.push(cue.id);
  }

  return (
    <div className="compare">
      <div className="compare-bar">
        <label>
          对照
          <select value={aVer} onChange={(e) => setAVer(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {venueById(v.venueId).name}
              </option>
            ))}
          </select>
        </label>
        <label>
          与
          <select value={bVer} onChange={(e) => setBVer(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {venueById(v.venueId).name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        {a.note} ⟶ {b.note}
      </p>
      {versions.length < 2 && <p className="hint">完成一次场地切换后,这里会出现复用前后的差异。</p>}
      <div className="table-wrap">
        <table className="cue-table compare-table">
          <thead>
            <tr>
              <th>节点</th>
              {DIFF_FIELDS.map((f) => (
                <th key={f.label}>{f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cueIds.map((cueId) => {
              const ca = a.script.cues.find((c) => c.id === cueId);
              const cb = b.script.cues.find((c) => c.id === cueId);
              const label = (cb ?? ca)?.label ?? cueId;
              return (
                <tr key={cueId}>
                  <td>
                    <b>{label}</b>
                  </td>
                  {DIFF_FIELDS.map((f) => (
                    <DiffCell key={f.label} va={ca ? f.read(ca) : undefined} vb={cb ? f.read(cb) : undefined} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffCell({ va, vb }: { va?: string; vb?: string }) {
  if (va === undefined) return <td><span className="changed">— → {vb}</span></td>;
  if (vb === undefined) return <td><span className="changed">{va} → —</span></td>;
  return <td>{va === vb ? va : <span className="changed">{va} → {vb}</span>}</td>;
}

export default App;
