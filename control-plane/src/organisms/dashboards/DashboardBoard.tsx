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
const N = DASH_WEEKS.length - 1; // 11 gaps between 12 points

interface DashboardBoardProps {
  query: string;
  scopeHint: string;
  onFollowup: (query: string) => void;
  /** A dashboard DOCUMENT's spec — when given, summary/KPIs/titles/table render from it (spec 2026-08-11). Absent = the mock fixtures. */
  spec?: DashSpec;
}

const ChartHitBand = ({ i, w, onHover }: { i: number; w: string; onHover: (idx: number) => void }) => (
  <>
    {/* biome-ignore lint/a11y/noStaticElementInteractions: hover hit-band for tooltip; values readable without hover in axis/table/legend */}
    <rect
      key={w}
      className="dash-chart__hit"
      x={((i - 0.5) * CHART_W) / N}
      y="0"
      width={CHART_W / N}
      height={CHART_H}
      onMouseEnter={() => onHover(i)}
    />
  </>
);

export function DashboardBoard({ query, scopeHint, onFollowup, spec }: DashboardBoardProps) {
  const [hover, setHover] = useState<number | null>(null);
  const maxStage = Math.max(...DASH_STAGE_BARS.map((s) => s.value));
  // Spec-or-fixture selection: a doc-backed dashboard renders its own words
  // and numbers; the series visuals stay decorative fixtures either way.
  const answer = spec?.summary ?? DASH_ANSWER;
  const kpis: Array<{ label: string; value: string; delta?: string; tone?: string; bar?: number }> =
    spec?.kpis ?? DASH_KPIS;
  const lineTitle = spec?.charts.find((c) => c.kind === "line")?.title ?? "throughput vs. intake";
  const barsTitle = spec?.charts.find((c) => c.kind === "bars")?.title ?? "where work is sitting";
  return (
    <div className="dash-board">
      <div className="dash-board__banner">
        <Sparkles size={16} aria-hidden="true" />
        <div>
          <div className="dash-board__question">{query}</div>
          <div className="dash-board__answer">{answer}</div>
          <div className="dash-board__meta">
            <span>{scopeHint}</span>
            <span>12 WEEKS</span>
            <span>UPDATED 2 MIN AGO</span>
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
              <i className="dash-legend__swatch dash-legend__swatch--line" /> shipped
              <i className="dash-legend__swatch dash-legend__swatch--ref" /> intake
            </span>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip enrichment — every value is also in the axis, legend and table; nothing is click- or keyboard-gated */}
          <div className="dash-chart" onMouseLeave={() => setHover(null)}>
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Shipped and intake per week over 12 weeks"
            >
              <defs>
                <linearGradient id="dash-fill-a" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--dash-line)" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="var(--dash-line)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0 40H640M0 90H640M0 140H640M0 175H640" className="dash-chart__grid" />
              <path
                d={seriesPath(DASH_SHIPPED, { w: CHART_W, h: CHART_H, max: CHART_MAX, close: true })}
                fill="url(#dash-fill-a)"
              />
              <path
                d={seriesPath(DASH_SHIPPED, { w: CHART_W, h: CHART_H, max: CHART_MAX })}
                className="dash-chart__line"
              />
              <path
                d={seriesPath(DASH_INTAKE, { w: CHART_W, h: CHART_H, max: CHART_MAX })}
                className="dash-chart__ref"
              />
              {hover !== null && (
                <line
                  className="dash-chart__cross"
                  x1={(hover * CHART_W) / N}
                  x2={(hover * CHART_W) / N}
                  y1="0"
                  y2={CHART_H}
                />
              )}
              {DASH_WEEKS.map((w, i) => (
                <ChartHitBand key={w} i={i} w={w} onHover={setHover} />
              ))}
            </svg>
            {hover !== null && (
              <div className="dash-chart__tip" style={{ left: `${(hover / N) * 100}%` }}>
                <strong>{DASH_WEEKS[hover]}</strong> shipped {DASH_SHIPPED[hover]} · intake {DASH_INTAKE[hover]}
              </div>
            )}
          </div>
          <div className="dash-chart__weeks">
            {DASH_WEEKS.filter((_, i) => i % 2 === 0).map((w) => (
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
            {DASH_STAGE_BARS.map((s) => (
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
