import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  adaptShowToVenue,
  allShots,
  effectiveEndS,
  findPoint,
  fmtTime,
  recomputeShot,
  shotEndS,
  SEGMENT_COLORS,
  SOURCE_SHOW,
  VENUES,
  type Segment,
  type Shot,
  type Show,
  type Venue,
  type Version,
} from "./model";
import {
  CONFLICT_KIND_LABEL,
  conflictShotIds,
  validateShowOnVenue,
  type Conflict,
} from "./validate";

/** 待提交的切换草稿：目标场地 + 改编后脚本 */
interface Draft {
  venueId: string;
  show: Show;
  savedAt: number;
}

const DRAFT_KEY = "hxyfront-62008:draft";
const VERSIONS_KEY = "hxyfront-62008:versions";

const loadJSON = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const initialVersions = (): Version[] => {
  const saved = loadJSON<Version[]>(VERSIONS_KEY);
  if (Array.isArray(saved) && saved.length > 0) return saved;
  return [
    {
      id: "v1",
      label: "滨江剧场原版",
      venueId: VENUES[0].id,
      show: SOURCE_SHOW,
      savedAt: Date.now(),
    },
  ];
};

const venueById = (id: string): Venue => VENUES.find((v) => v.id === id) ?? VENUES[0];

const segColor = (segId: string): string => SEGMENT_COLORS[segId] ?? "#64748b";

// ---------------------------------------------------------------------------
// 时间轴
// ---------------------------------------------------------------------------

function Timeline(props: {
  show: Show;
  venue: Venue;
  conflicts: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { show, venue, conflicts, selectedId, onSelect } = props;
  const shots = allShots(show);
  const tMax =
    Math.max(show.endTimeS, venue.curfewS ?? 0, ...shots.map(shotEndS)) * 1.04;
  const X = (t: number) => 70 + (t / tMax) * 900;
  const rowH = 46;
  const height = 56 + show.segments.length * rowH;
  const ticks: number[] = [];
  for (let t = 0; t <= tMax; t += 30) ticks.push(t);

  return (
    <svg className="timeline" viewBox={`0 0 1000 ${height}`} role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={X(t)} y1={24} x2={X(t)} y2={height - 24} className="tl-grid" />
          <text x={X(t)} y={14} className="tl-tick" textAnchor="middle">
            {fmtTime(t)}
          </text>
        </g>
      ))}

      {show.segments.map((seg, i) => {
        const y = 34 + i * rowH;
        return (
          <g key={seg.id}>
            <text x={8} y={y + 18} className="tl-seg">
              {seg.name}
              {seg.locked ? " 🔒" : ""}
            </text>
            <line x1={70} y1={y + 12} x2={970} y2={y + 12} className="tl-row" />
            {seg.shots.map((shot) => {
              const bad = conflicts.has(shot.id);
              const selected = shot.id === selectedId;
              return (
                <g
                  key={shot.id}
                  className="tl-shot"
                  onClick={() => onSelect(shot.id)}
                >
                  <rect
                    x={X(shot.anchorS)}
                    y={y + 4}
                    width={Math.max(3, X(shotEndS(shot)) - X(shot.anchorS))}
                    height={16}
                    rx={3}
                    fill={bad ? "#dc2626" : segColor(seg.id)}
                    opacity={selected ? 1 : 0.75}
                    stroke={selected ? "#172033" : "none"}
                    strokeWidth={selected ? 2 : 0}
                  />
                  <polygon
                    points={`${X(shot.anchorS)},${y - 4} ${X(shot.anchorS) - 5},${y + 4} ${X(shot.anchorS) + 5},${y + 4}`}
                    fill={bad ? "#dc2626" : "#172033"}
                  />
                </g>
              );
            })}
          </g>
        );
      })}

      <line x1={X(show.endTimeS)} y1={20} x2={X(show.endTimeS)} y2={height - 20} className="tl-end" />
      <text x={X(show.endTimeS)} y={height - 8} className="tl-end-label" textAnchor="middle">
        节目结束 {fmtTime(show.endTimeS)}
      </text>
      {venue.curfewS !== undefined && (
        <>
          <line x1={X(venue.curfewS)} y1={20} x2={X(venue.curfewS)} y2={height - 20} className="tl-curfew" />
          <text x={X(venue.curfewS)} y={height - 8} className="tl-curfew-label" textAnchor="end">
            场地宵禁 {fmtTime(venue.curfewS)}
          </text>
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 点位平面图
// ---------------------------------------------------------------------------

function SiteMap(props: {
  venue: Venue;
  show: Show;
  conflicts: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { venue, show, conflicts, selectedId, onSelect } = props;
  const pad = 60;
  const grid: number[] = [];
  for (let g = 0; g <= Math.max(venue.width, venue.depth); g += 10) grid.push(g);

  return (
    <svg
      className="sitemap"
      viewBox={`${-pad} ${-pad} ${venue.width + pad * 2} ${venue.depth + pad * 2}`}
      role="img"
    >
      {grid.map((g) => (
        <g key={g}>
          {g <= venue.width && (
            <line x1={g} y1={0} x2={g} y2={venue.depth} className="sm-grid" />
          )}
          {g <= venue.depth && (
            <line x1={0} y1={g} x2={venue.width} y2={g} className="sm-grid" />
          )}
        </g>
      ))}
      <rect x={0} y={0} width={venue.width} height={venue.depth} className="sm-bound" />
      <text x={0} y={venue.depth + 16} className="sm-label">
        {venue.name} · {venue.width}×{venue.depth}m
      </text>

      <polygon
        points={`${venue.aim.x},${venue.aim.y - 6} ${venue.aim.x - 6},${venue.aim.y + 5} ${venue.aim.x + 6},${venue.aim.y + 5}`}
        className="sm-aim"
      />
      <text x={venue.aim.x + 9} y={venue.aim.y + 4} className="sm-label">
        观众锚点
      </text>

      {show.segments.flatMap((seg) =>
        seg.shots.map((shot) => {
          const point = findPoint(venue, shot.pointNo);
          if (!point) return null;
          const bad = conflicts.has(shot.id);
          const selected = shot.id === selectedId;
          return (
            <circle
              key={shot.id}
              cx={point.x}
              cy={point.y}
              r={shot.burstRadiusM}
              className="sm-burst"
              fill={bad ? "#dc2626" : segColor(seg.id)}
              fillOpacity={bad ? 0.22 : 0.14}
              stroke={bad ? "#dc2626" : segColor(seg.id)}
              strokeWidth={selected ? 1.8 : 0.7}
              strokeDasharray={bad ? "3 2" : seg.locked ? "2 2" : undefined}
              onClick={() => onSelect(shot.id)}
            />
          );
        })
      )}

      {venue.points.map((p) => (
        <g key={p.no}>
          <rect x={p.x - 2.4} y={p.y - 2.4} width={4.8} height={4.8} className="sm-point" />
          <text x={p.x + 4} y={p.y - 4} className="sm-point-no">
            {p.no}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 版本对照
// ---------------------------------------------------------------------------

const DIFF_FIELDS: { key: keyof Shot; label: string; fmt: (v: number | string) => string }[] = [
  { key: "pointNo", label: "点位", fmt: (v) => `${v} 号` },
  { key: "angleDeg", label: "发射角", fmt: (v) => `${Number(v).toFixed(1)}°` },
  { key: "burstRadiusM", label: "爆开范围", fmt: (v) => `${Number(v).toFixed(1)}m` },
  { key: "anchorS", label: "音乐锚点", fmt: (v) => fmtTime(Number(v)) },
  { key: "durationS", label: "持续", fmt: (v) => `${Number(v).toFixed(1)}s` },
];

function VersionDiff(props: { versions: Version[] }) {
  const { versions } = props;
  const [pick, setPick] = useState<[string, string] | null>(null);
  const aId = pick?.[0] ?? versions[0]?.id;
  const bId = pick?.[1] ?? versions[versions.length - 1]?.id;
  const va = versions.find((v) => v.id === aId) ?? versions[0];
  const vb = versions.find((v) => v.id === bId) ?? versions[versions.length - 1];
  if (!va || !vb) return null;

  const mapB = new Map(allShots(vb.show).map((s) => [s.id, s]));
  const rows = allShots(va.show).map((sa) => ({ a: sa, b: mapB.get(sa.id) }));

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>版本对照</p>
          <h2>改编前后逐节点比对</h2>
        </div>
        <div className="diff-pick">
          <select value={va.id} onChange={(e) => setPick([e.target.value, vb.id])}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <span>→</span>
          <select value={vb.id} onChange={(e) => setPick([va.id, e.target.value])}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted">
        {va.label}（{venueById(va.venueId).name}）对比 {vb.label}（{venueById(vb.venueId).name}），音乐锚点时刻保持不变。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>段落 / 节点</th>
              {DIFF_FIELDS.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, b }) => (
              <tr key={a.id}>
                <td>
                  {a.segmentName} · {a.product}
                  {a.segmentLocked && <span className="badge lock">已锁</span>}
                </td>
                {DIFF_FIELDS.map((f) => {
                  const changed = b !== undefined && a[f.key] !== b[f.key];
                  return (
                    <td key={f.key} className={changed ? "changed" : ""}>
                      {changed
                        ? `${f.fmt(a[f.key])} → ${f.fmt(b![f.key])}`
                        : f.fmt(a[f.key])}
                    </td>
                  );
                })}
                <td className="muted">
                  {a.segmentLocked
                    ? "锁定段未自动改编"
                    : b && DIFF_FIELDS.some((f) => a[f.key] !== b![f.key])
                      ? "已按编号重算"
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 主页面：场地复用台
// ---------------------------------------------------------------------------

function App() {
  const [versions, setVersions] = useState<Version[]>(initialVersions);
  const [draft, setDraft] = useState<Draft | null>(() => loadJSON<Draft>(DRAFT_KEY));
  const [targetVenueId, setTargetVenueId] = useState<string>(VENUES[1].id);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const current = versions[versions.length - 1];
  const currentVenue = venueById(current.venueId);
  const draftVenue = draft ? venueById(draft.venueId) : null;

  // 当前展示对象：有草稿看草稿，否则看已提交的当前版本
  const viewShow = draft ? draft.show : current.show;
  const viewVenue = draftVenue ?? currentVenue;

  const conflicts: Conflict[] = useMemo(
    () => validateShowOnVenue(viewShow, viewVenue),
    [viewShow, viewVenue]
  );
  const conflictIds = useMemo(() => conflictShotIds(conflicts), [conflicts]);
  const shots = useMemo(() => allShots(viewShow), [viewShow]);

  // 目标场地默认选"另一套"，且不允许与当前场地相同
  useEffect(() => {
    if (targetVenueId === currentVenue.id) {
      const other = VENUES.find((v) => v.id !== currentVenue.id);
      if (other) setTargetVenueId(other.id);
    }
  }, [currentVenue.id, targetVenueId]);

  // 草稿同步保存
  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  }, [draft]);

  // 版本同步保存
  useEffect(() => {
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions));
  }, [versions]);

  const copyAndAdapt = () => {
    const to = venueById(targetVenueId);
    setDraft({
      venueId: to.id,
      show: adaptShowToVenue(current.show, currentVenue, to),
      savedAt: Date.now(),
    });
  };

  const updateDraftShot = (shotId: string, patch: Partial<Shot>) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            savedAt: Date.now(),
            show: {
              ...d.show,
              segments: d.show.segments.map((seg) => ({
                ...seg,
                shots: seg.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)),
              })),
            },
          }
        : d
    );
  };

  const recomputeOne = (shotId: string) => {
    if (!draft || !draftVenue) return;
    const shot = allShots(draft.show).find((s) => s.id === shotId);
    if (!shot) return;
    updateDraftShot(shotId, recomputeShot(shot, currentVenue, draftVenue));
  };

  const commit = () => {
    if (!draft || !draftVenue || conflicts.length > 0) return; // 有冲突停止切换
    setVersions((vs) => [
      ...vs,
      {
        id: `v${vs.length + 1}`,
        label: `${draftVenue.name.replace(/（.*）/, "")}复用版`,
        venueId: draftVenue.id,
        show: draft.show,
        savedAt: Date.now(),
      },
    ]);
    setDraft(null);
    setSelectedId(null);
  };

  const num = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

  const renderSegmentRows = (seg: Segment) =>
    seg.shots.map((shot) => {
      const bad = conflictIds.has(shot.id);
      return (
        <tr
          key={shot.id}
          className={`${bad ? "row-conflict" : ""} ${shot.id === selectedId ? "row-selected" : ""}`}
          onClick={() => setSelectedId(shot.id)}
        >
          <td>
            {shot.product}
            <span className="muted"> {shot.caliberMm}mm</span>
          </td>
          <td>
            <input
              type="number"
              min={1}
              value={shot.pointNo}
              disabled={!draft}
              onChange={(e) =>
                updateDraftShot(shot.id, { pointNo: num(e.target.valueAsNumber, shot.pointNo) })
              }
            />
          </td>
          <td>
            <input
              type="number"
              step={0.1}
              value={shot.angleDeg}
              disabled={!draft}
              onChange={(e) =>
                updateDraftShot(shot.id, { angleDeg: num(e.target.valueAsNumber, shot.angleDeg) })
              }
            />
          </td>
          <td>
            <input
              type="number"
              step={0.1}
              min={0}
              value={shot.burstRadiusM}
              disabled={!draft}
              onChange={(e) =>
                updateDraftShot(shot.id, {
                  burstRadiusM: num(e.target.valueAsNumber, shot.burstRadiusM),
                })
              }
            />
          </td>
          <td className="anchor">{fmtTime(shot.anchorS)}</td>
          <td>
            <input
              type="number"
              step={0.5}
              min={0}
              value={shot.durationS}
              disabled={!draft}
              onChange={(e) =>
                updateDraftShot(shot.id, { durationS: num(e.target.valueAsNumber, shot.durationS) })
              }
            />
          </td>
          <td>
            <button
              className="mini"
              disabled={!draft}
              title="按当前点位编号重算发射角与爆开范围"
              onClick={(e) => {
                e.stopPropagation();
                recomputeOne(shot.id);
              }}
            >
              重算
            </button>
          </td>
        </tr>
      );
    });

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 场地复用台</p>
        <h1>巡演脚本换场复用</h1>
        <span>
          复制旧场地脚本到新场地后，按点位编号重算发射角与爆开范围；音乐锚点时刻不变，已锁段落不自动改编。
          新点越界、相邻范围相交或节点越过节目结束时停止切换，修好再提交。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>节目段落</small>
          <strong>{viewShow.segments.length}</strong>
        </article>
        <article>
          <small>点火节点</small>
          <strong>{shots.length}</strong>
        </article>
        <article>
          <small>冲突提示</small>
          <strong className={conflicts.length > 0 ? "danger" : ""}>{conflicts.length}</strong>
        </article>
        <article>
          <small>有效结束</small>
          <strong>{fmtTime(effectiveEndS(viewShow, viewVenue))}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>场地切换</p>
            <h2>
              {currentVenue.name} → {venueById(targetVenueId).name}
            </h2>
          </div>
          <div className="actions">
            <select value={targetVenueId} onChange={(e) => setTargetVenueId(e.target.value)}>
              {VENUES.filter((v) => v.id !== currentVenue.id).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button className="primary" onClick={copyAndAdapt}>
              {draft ? "重新复制并改编" : "复制并改编"}
            </button>
            <button
              className="primary"
              disabled={!draft || conflicts.length > 0}
              title={conflicts.length > 0 ? "存在冲突，停止切换" : "提交切换"}
              onClick={commit}
            >
              提交切换
            </button>
            {draft && <button onClick={() => setDraft(null)}>放弃草稿</button>}
          </div>
        </div>

        {draft ? (
          conflicts.length > 0 ? (
            <div className="banner danger">
              切换已停止：{conflicts.length} 项冲突待处理，修好再提交。草稿已同步保存（
              {new Date(draft.savedAt).toLocaleTimeString()}）。
            </div>
          ) : (
            <div className="banner ok">
              校验通过，可以提交切换。草稿已同步保存（
              {new Date(draft.savedAt).toLocaleTimeString()}）。
            </div>
          )
        ) : (
          <div className="banner">
            当前生效：{current.label}（{currentVenue.name}）。选择目标场地后点击"复制并改编"生成草稿。
          </div>
        )}

        {conflicts.length > 0 && (
          <ul className="conflicts">
            {conflicts.map((c, i) => (
              <li key={i}>
                <span className={`badge kind-${c.kind}`}>{CONFLICT_KIND_LABEL[c.kind]}</span>
                <span>{c.message}</span>
                <button className="mini" onClick={() => setSelectedId(c.shotIds[0])}>
                  定位
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="workspace">
        <section className="panel">
          <div className="heading">
            <div>
              <p>点位平面图</p>
              <h2>{viewVenue.name}</h2>
            </div>
          </div>
          <SiteMap
            venue={viewVenue}
            show={viewShow}
            conflicts={conflictIds}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <div className="legend">
            {viewShow.segments.map((seg) => (
              <span key={seg.id}>
                <i style={{ background: segColor(seg.id) }} />
                {seg.name}
                {seg.locked ? " 🔒" : ""}
              </span>
            ))}
            <span>
              <i style={{ background: "#dc2626" }} />
              冲突节点
            </span>
          </div>
        </section>

        <section className="panel">
          <div className="heading">
            <div>
              <p>{draft ? "草稿编辑（改编后）" : "当前脚本"}</p>
              <h2>{viewShow.name}</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>节点</th>
                  <th>点位</th>
                  <th>发射角°</th>
                  <th>范围m</th>
                  <th>音乐锚点</th>
                  <th>持续s</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {viewShow.segments.map((seg) => (
                  <SegmentBlock
                    key={seg.id}
                    seg={seg}
                    rows={renderSegmentRows(seg)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {!draft && <p className="muted">当前为已提交版本，复制并改编后可在草稿中修改。</p>}
        </section>
      </div>

      <section className="panel">
        <div className="heading">
          <div>
            <p>时间轴编排</p>
            <h2>{draft ? "草稿时间轴" : "当前时间轴"}</h2>
          </div>
        </div>
        <Timeline
          show={viewShow}
          venue={viewVenue}
          conflicts={conflictIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </section>

      <VersionDiff versions={versions} />
    </main>
  );
}

function SegmentBlock(props: { seg: Segment; rows: React.ReactNode }) {
  const { seg, rows } = props;
  return (
    <>
      <tr className="seg-row">
        <td colSpan={7}>
          <span className="seg-dot" style={{ background: segColor(seg.id) }} />
          {seg.name}
          {seg.locked && <span className="badge lock">已锁 · 不自动改编</span>}
        </td>
      </tr>
      {rows}
    </>
  );
}

export default App;
