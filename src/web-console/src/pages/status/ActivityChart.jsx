import { useEffect, useRef, useState } from "react";
import { formatTrendLabel } from "../../lib/format.js";
import { Empty, Loading } from "../../components/ui.jsx";
import { WEB_TOOLS, classifyError } from "../../lib/request.js";

export const REQUEST_SERIES = [
  { key: "web-ok", label: "Web succeeded", color: "var(--series-web-ok)" },
  { key: "web-fail", label: "Web failed", color: "var(--series-web-fail)" },
  { key: "devtools-ok", label: "DevTools succeeded", color: "var(--series-devtools-ok)" },
  { key: "devtools-fail", label: "DevTools failed", color: "var(--series-devtools-fail)" },
];
export function requestValue(bucket, key) {
  const [category, status] = key.split("-");
  return bucket[category]?.[status] || 0;
}

export function ActivityLineChart({ buckets, range }) {
  const [selected, setSelected] = useState(null);
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth ? el.clientWidth / 800 : 1;
      setScale(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(1, ...buckets.flatMap((bucket) => REQUEST_SERIES.map((series) => requestValue(bucket, series.key))));
  const width = 800;
  const height = 260;
  const left = 38;
  const right = 10;
  const top = 8;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const active = selected;
  const xFor = (index) => (buckets.length === 1 ? left + plotWidth / 2 : left + (index / (buckets.length - 1)) * plotWidth);
  const yFor = (value) => top + plotHeight - (value / max) * plotHeight;
  const pathFor = (series) => {
    const points = buckets.map((item, index) => ({ x: xFor(index), y: yFor(requestValue(item, series.key)) }));
    if (points.length < 2) return "";
    const clampY = (value) => Math.max(top, Math.min(top + plotHeight, value));
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 0; index < points.length - 1; index += 1) {
      const previous = points[Math.max(0, index - 1)];
      const current = points[index];
      const next = points[index + 1];
      const afterNext = points[Math.min(points.length - 1, index + 2)];
      const control1 = { x: current.x + (next.x - previous.x) / 6, y: clampY(current.y + (next.y - previous.y) / 6) };
      const control2 = { x: next.x - (afterNext.x - current.x) / 6, y: clampY(next.y - (afterNext.y - current.y) / 6) };
      path += ` C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${next.x} ${next.y}`;
    }
    return path;
  };
  const every = Math.max(1, Math.ceil(buckets.length / 4));
  return <>
    <div className="request-trend-chart" ref={wrapRef} role="img" aria-label="Web and DevTools request line graph" style={{ "--tscale": scale }}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {[0, 0.5, 1].map((ratio) => {
          const y = top + plotHeight - ratio * plotHeight;
          return <g key={ratio}><line className="request-trend-grid" x1={left} x2={width - right} y1={y} y2={y} /><text x={left - 5} y={y + 4} textAnchor="end">{Math.round(max * ratio)}</text></g>;
        })}
        {REQUEST_SERIES.map((series) => (
          <g key={series.key}>
            <path className="request-trend-line" style={{ "--series": series.color }} d={pathFor(series)} />
            {buckets.map((item, index) => (
              <circle key={item.ts} className="request-trend-dot" cx={xFor(index)} cy={yFor(requestValue(item, series.key))} r={active === index ? 3.5 : 2.25} style={{ "--series": series.color }} />
            ))}
          </g>
        ))}
        {buckets.map((item, index) => {
          const x = xFor(index);
          const half = buckets.length > 1 ? plotWidth / (buckets.length - 1) / 2 : plotWidth / 2;
          const tooltip = `${formatTrendLabel(item.ts, range)} · Web ${item.web?.ok || 0} ok / ${item.web?.fail || 0} fail · DevTools ${item.devtools?.ok || 0} ok / ${item.devtools?.fail || 0} fail`;
          return <g key={item.ts} onMouseEnter={() => setSelected(index)} onMouseLeave={() => setSelected(null)}><rect className="request-trend-hit" data-tooltip={tooltip} x={x - half} y={top} width={half * 2} height={plotHeight} />{(index === 0 || index === buckets.length - 1 || index % every === 0) && <text className="request-trend-label" x={x} y={height - 8} textAnchor="middle">{formatTrendLabel(item.ts, range)}</text>}</g>;
        })}
      </svg>
      </div>
  </>;
}
export function RequestActivityTrend({ trend, range, error, setRange }) {
  const buckets = trend?.buckets || [];
  return (
    <section className="panel request-trend">
      <div className="request-trend-heading">
        <div>
          <h2>Request activity</h2>
          <div className="request-trend-summary">
            <b>{trend?.summary?.total || 0} total</b>
            <span>{trend?.summary?.ok || 0} succeeded</span>
            <span className={trend?.summary?.fail ? "request-trend-fail" : ""}>{trend?.summary?.fail || 0} failed</span>
          </div>
        </div>
        <div className="request-trend-actions">
          <div className="request-trend-controls" aria-label="Request activity filters">
            {["minutes", "hour", "day", "week"].map((item) => (
              <button key={item} className={range === item ? "active" : ""} aria-pressed={range === item} onClick={() => setRange(item)}>
                {{ minutes: "15 minutes", hour: "1 hour", day: "24 hours", week: "7 days" }[item]}
              </button>
            ))}
          </div>
          <div className="request-trend-key" aria-label="Request outcome legend">
            {REQUEST_SERIES.map((series) => <span key={series.key}><i style={{ "--series": series.color }} />{series.label}</span>)}
          </div>
        </div>
      </div>
      {error ? <Empty>Could not load activity trend: {error}</Empty> : !buckets.length ? <Loading>Loading activity trend…</Loading> : (
        <ActivityLineChart buckets={buckets} range={range} />
      )}
    </section>
  );
}

export function computeStatus(health, stats, ok) {
  const issues = [];
  let level = "ok";
  const mark = (next, text, extra) => {
    issues.push({ level: next, text, ...(extra || {}) });
    if (
      { ok: 0, degraded: 1, critical: 2 }[next] >
      { ok: 0, degraded: 1, critical: 2 }[level]
    )
      level = next;
  };
  if (!ok) mark("critical", "server unreachable");
  if (
    health?.pageLimiter?.maxConcurrentPageOps &&
    health.pageLimiter.inUse >= health.pageLimiter.maxConcurrentPageOps
  )
    mark(
      "degraded",
      `page ops saturated (${health.pageLimiter.inUse}/${health.pageLimiter.maxConcurrentPageOps}${health.pageLimiter.queued ? `, ${health.pageLimiter.queued} queued` : ""})`,
    );
  if (health?.vnc?.running && health.vnc.headed === false)
    mark("degraded", "VNC running but browser still headless");
  if (health?.vnc?.enabled && !health.vnc.running)
    mark("degraded", "VNC enabled but noVNC unreachable");
  const errors = (stats?.requests?.recentErrors || []).filter(
    (entry) => WEB_TOOLS.has(entry.tool) && !classifyError(entry).expected,
  );
  if (errors.length)
    mark("degraded", `${errors.length} recent web browsing error(s)`, {
      detail: errors,
    });
  return { level, issues };
}
