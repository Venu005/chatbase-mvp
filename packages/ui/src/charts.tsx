"use client";

import { useState } from "react";

/** Clean axis maximum (1, 2, 5 × 10ⁿ) at or above the largest value, never below `floor`. */
export function niceMax(v: number, floor = 4): number {
  if (v <= floor) return floor;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

export const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "bad" | "good" }) {
  return (
    <div className={`tile${tone ? ` ${tone}` : ""}`}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

/**
 * Single-series column chart over days. Hover (or keyboard focus) a column for its exact value; the same data is
 * available as a table. `format` renders values (axis, tooltip, table); `noun(n)` names what is counted.
 */
export function ColumnChart({
  points,
  title,
  format = (n) => n.toLocaleString("en-IN"),
  noun,
  floor = 4,
}: {
  points: { day: string; value: number }[];
  title: string;
  format?: (n: number) => string;
  noun: (n: number) => string;
  floor?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...points.map((d) => d.value)), floor);
  const h = hover === null ? null : points[hover];
  return (
    <figure className="chart" aria-label={title}>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="chart-grid" style={{ bottom: `${f * 100}%` }}>
            <span>{format(max * f)}</span>
          </div>
        ))}
        <div className="chart-cols">
          {points.map((d, i) => (
            <button
              key={d.day}
              type="button"
              className={`chart-col${hover === i ? " on" : ""}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${dayLabel(d.day)}: ${format(d.value)} ${noun(d.value)}`}
            >
              <span style={{ height: `${(d.value / max) * 100}%` }} />
            </button>
          ))}
        </div>
        {h && (
          <div className="chart-tip" style={{ left: `${((hover! + 0.5) / points.length) * 100}%` }} role="status">
            <span className="muted">{dayLabel(h.day)}</span> <strong>{format(h.value)}</strong> {noun(h.value)}
          </div>
        )}
      </div>
      <div className="chart-x muted small">
        <span>{dayLabel(points[0].day)}</span>
        <span>{dayLabel(points[points.length - 1].day)}</span>
      </div>
      <details className="small">
        <summary className="muted">Show as table</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>{title}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((d) => (
              <tr key={d.day}>
                <td>{dayLabel(d.day)}</td>
                <td>{format(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
