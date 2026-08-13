import { Sparkles } from "lucide-react";
import { useState } from "react";
import {
  DASH_ANSWER,
  DASH_FOLLOWUPS,
  DASH_INTAKE,
  DASH_KPIS,
  DASH_ROWS,
  DASH_SHIPPED,
  DASH_STAGE_BARS,
  DASH_WEEKS,
} from "../../data/dashboards";
import { seriesPath, sparkPath } from "../../lib/dashboard-paths";
import type { DashSpec } from "../../lib/dashboardSpec";

const CHART_W = 640;
const CHART_H = 190;
/** One shared ceiling for both series — one axis, never two. */
const CHART_MAX = 50;

interface DashboardBoardProps {
  query: string;
  scopeHint: string;
  onFollowup: (query: string) => void;
  /** A dashboard DOCUMENT's spec — when given, summary/KPIs/titles/table render from it (spec 2026-08-11). Absent = the mock fixtures. */
  spec?: DashSpec;
}

const ChartHitBand = ({
  i,
  w,
  gaps,
  onHover,
}: {
  i: number;
  w: string;
  gaps: number;
  onHover: (idx: number) => void;
}) => (
  <>
    {/* biome-ignore lint/a11y/noStaticElementInteractions: hover hit-band for tooltip; values readable without hover in axis/table/legend */}
    <rect
      key={w}
      className="dash-chart__hit"
      x={((i - 0.5) * CHART_W) / gaps}
      y="0"
      width={CHART_W / gaps}
      height={CHART_H}
      onMouseEnter={() => onHover(i)}
    />
  </>
);

export function DashboardBoard({ query, scopeHint, onFollowup, spec }: DashboardBoardProps) {
  const [hover, setHover] = useState<number | null>(null);
  // Spec-or-fixture selection: a doc-backed dashboard renders its own words
  // and numbers. Charts carrying `data` (real-dashboards spec 2026-08-13)
  // draw REAL series; without it the decorative fixtures stand in — the
  // ask-screen mock renders exactly as before.
  const answer = spec?.summary ?? DASH_ANSWER;
  const kpis: Array<{ label: string; value: string; delta?: string; tone?: string; bar?: number }> =
    spec?.kpis ?? DASH_KPIS;
  const lineChart = spec?.charts.find((c) => c.kind === "line");
  const barsChart = spec?.charts.find((c) => c.kind === "bars");
  const lineTitle = lineChart?.title ?? "throughput vs. intake";
  const barsTitle = barsChart?.title ?? "where work is sitting";
  const weeks = lineChart?.data?.labels ?? DASH_WEEKS;
  const seriesA = lineChart?.data?.series[0];
  const seriesB = lineChart?.data?.series[1];
  const lineA = seriesA?.values ?? DASH_SHIPPED;
  const lineB = lineChart?.data ? (seriesB?.values ?? null) : DASH_INTAKE;
  // One shared ceiling for whatever is drawn — one axis, never two. Min 1 so
  // an all-zero window still draws a flat line instead of dividing by zero.
  const lineMax = lineChart?.data ? Math.max(1, ...lineA, ...(lineB ?? [])) : CHART_MAX;
  const gaps = Math.max(1, weeks.length - 1);
  const stageBars = barsChart?.data
    ? barsChart.data.labels.map((label, i) => ({ label, value: barsChart.data?.series[0]?.values[i] ?? 0 }))
    : DASH_STAGE_BARS;
  const maxStage = Math.max(1, ...stageBars.map((s) => s.value));
  const legendA = seriesA?.name ?? "shipped";
  const legendB = lineChart?.data ? (seriesB?.name ?? null) : "intake";
  return (
    <div className="dash-board">
      <div className="dash-board__banner">
        <Sparkles size={16} aria-hidden="true" />
        <div>
          <div className="dash-board__question">{query}</div>
          <div className="dash-board__answer">{answer}</div>
          <div className="dash-board__meta">
            <span>{scopeHint}</span>
            {/* The mock's flavor copy stays mock-only — a real dashboard's
                window is already in its scope hint. */}
            {!spec && (
              <>
                <span>12 WEEKS</span>
                <span>UPDATED 2 MIN AGO</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="dash-board__kpis">
        {kpis.map((k) => (
          <div key={k.label} className="dash-kpi">
            <div className="dash-kpi__label">{k.label}</div>
            <div className="dash-kpi__row">
              <span className="dash-kpi__value">{k.value}</span>
              {k.delta && <span className={`dash-kpi__delta dash-tone--${k.tone ?? "ok"}`}>{k.delta}</span>}
            </div>
            {k.bar !== undefined && (
              <div className="dash-kpi__meter">
                <div className={`dash-kpi__fill dash-fill--${k.tone ?? "ok"}`} style={{ width: `${k.bar * 100}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="dash-board__charts">
        <section className="dash-panel" aria-label="Throughput vs intake">
          <div className="dash-panel__head">
            <span>{lineTitle}</span>
            <span className="dash-panel__legend">
              <i className="dash-legend__swatch dash-legend__swatch--line" /> {legendA}
              {legendB && (
                <>
                  <i className="dash-legend__swatch dash-legend__swatch--ref" /> {legendB}
                </>
              )}
            </span>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip enrichment — every value is also in the axis, legend and table; nothing is click- or keyboard-gated */}
          <div className="dash-chart" onMouseLeave={() => setHover(null)}>
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${legendA}${legendB ? ` and ${legendB}` : ""} per ${lineChart?.data ? "day" : "week"}`}
            >
              <defs>
                <linearGradient id="dash-fill-a" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--dash-line)" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="var(--dash-line)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0 40H640M0 90H640M0 140H640M0 175H640" className="dash-chart__grid" />
              <path
                d={seriesPath(lineA, { w: CHART_W, h: CHART_H, max: lineMax, close: true })}
                fill="url(#dash-fill-a)"
              />
              <path d={seriesPath(lineA, { w: CHART_W, h: CHART_H, max: lineMax })} className="dash-chart__line" />
              {lineB && (
                <path d={seriesPath(lineB, { w: CHART_W, h: CHART_H, max: lineMax })} className="dash-chart__ref" />
              )}
              {hover !== null && (
                <line
                  className="dash-chart__cross"
                  x1={(hover * CHART_W) / gaps}
                  x2={(hover * CHART_W) / gaps}
                  y1="0"
                  y2={CHART_H}
                />
              )}
              {weeks.map((w, i) => (
                <ChartHitBand key={w} i={i} w={w} gaps={gaps} onHover={setHover} />
              ))}
            </svg>
            {hover !== null && (
              <div className="dash-chart__tip" style={{ left: `${(hover / gaps) * 100}%` }}>
                <strong>{weeks[hover]}</strong> {legendA} {lineA[hover] ?? 0}
                {legendB && lineB ? ` · ${legendB} ${lineB[hover] ?? 0}` : ""}
              </div>
            )}
          </div>
          <div className="dash-chart__weeks">
            {weeks
              .filter((_, i) => i % 2 === 0)
              .map((w) => (
                <span key={w}>{w}</span>
              ))}
          </div>
        </section>

        <section className="dash-panel" aria-label="Cards by stage">
          <div className="dash-panel__head">
            <span>{barsTitle}</span>
          </div>
          <div className="dash-panel__sub">CARDS BY STAGE</div>
          <div className="dash-stagebars">
            {stageBars.map((s) => (
              <div key={s.label} className="dash-stagebars__col">
                <span className="dash-stagebars__num">{s.value}</span>
                <div
                  className={`dash-stagebars__bar ${s.label === "KILLED" ? "dash-stagebars__bar--dim" : ""}`}
                  style={{ height: `${(s.value / maxStage) * 150}px` }}
                />
                <span className="dash-stagebars__lab">{s.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {spec?.texts && spec.texts.length > 0 && (
        <div className="dash-text-cards">
          {spec.texts.map((t) => (
            <article key={t.title} className="dash-text-card">
              <h3 className="dash-text-card__title">{t.title}</h3>
              <p className="dash-text-card__body">{t.body}</p>
              {t.source && <span className="dash-text-card__source">{t.source}</span>}
            </article>
          ))}
        </div>
      )}

      {spec?.table ? (
        // A doc-backed dashboard's table renders its OWN columns and rows —
        // risk-like cells still get the pill treatment.
        <section className="dash-table" aria-label={spec.table.title}>
          <div className="dash-table__toprow">
            <span>{spec.table.title}</span>
          </div>
          <table>
            <thead>
              <tr>
                {spec.table.columns.map((c) => (
                  <th key={c}>{c.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.table.rows.map((row) => (
                <tr key={row.join("|")}>
                  {row.map((cell, i) => (
                    <td key={`${spec.table?.columns[i] ?? i}:${cell}`}>
                      {cell === "ok" || cell === "watch" || cell === "high" ? (
                        <span className={`dash-pill dash-pill--${cell}`}>{cell}</span>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="dash-table" aria-label="Workspace groups">
          <div className="dash-table__toprow">
            <span>workspace groups</span>
            <span className="dash-table__sort">SORTED BY RISK</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>GROUP</th>
                <th>CARDS</th>
                <th>WIP</th>
                <th>CYCLE</th>
                <th>12-WEEK TREND</th>
                <th>RISK</th>
              </tr>
            </thead>
            <tbody>
              {DASH_ROWS.map((r) => (
                <tr key={r.name}>
                  <td className="dash-table__group">
                    <i className={`dash-table__dot dash-fill--${r.risk}`} />
                    {r.name}
                  </td>
                  <td className="dash-table__num">{r.cards}</td>
                  <td className="dash-table__num">{r.wip}</td>
                  <td className="dash-table__num">{r.cycle}</td>
                  <td>
                    <svg viewBox="0 0 100 22" className="dash-table__spark" aria-hidden="true">
                      <path d={sparkPath(r.trend)} className={`dash-spark--${r.risk}`} />
                    </svg>
                  </td>
                  <td>
                    <span className={`dash-pill dash-pill--${r.risk}`}>{r.risk}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="dash-board__followups">
        {DASH_FOLLOWUPS.map((f) => (
          <button key={f} type="button" className="dash-followup" onClick={() => onFollowup(f)}>
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}
