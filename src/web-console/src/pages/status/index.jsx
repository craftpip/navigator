import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatMs, formatCountdown, formatTime, formatRelativeTime, formatBackend, formatTrendLabel } from "../../lib/format.js";
import { WEB_TOOLS, request, classifyError } from "../../lib/request.js";
import { Panel, Empty, Dot, Pill, Trend, Metric, Item, Countdown } from "../../components/ui.jsx";

const REQUEST_SERIES = [
  { key: "web-ok", label: "Web succeeded", color: "var(--series-web-ok)" },
  { key: "web-fail", label: "Web failed", color: "var(--series-web-fail)" },
  { key: "devtools-ok", label: "DevTools succeeded", color: "var(--series-devtools-ok)" },
  { key: "devtools-fail", label: "DevTools failed", color: "var(--series-devtools-fail)" },
];
function requestValue(bucket, key) {
  const [category, status] = key.split("-");
  return bucket[category]?.[status] || 0;
}

function ActivityLineChart({ buckets, range }) {
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
function RequestActivityTrend({ trend, range, error, setRange }) {
  const buckets = trend?.buckets || [];
  return (
    <section className="panel request-trend">
      <div className="request-trend-heading">
        <div>
          <h2>Request activity <span className="sub">incoming requests and engine attempts</span></h2>
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
      {error ? <Empty>Could not load activity trend: {error}</Empty> : !buckets.length ? <Empty>Loading activity trend…</Empty> : (
        <ActivityLineChart buckets={buckets} range={range} />
      )}
    </section>
  );
}

function computeStatus(health, stats, ok) {
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

function StatusView({ snapshot, history, toggleVnc, vncBusy, feed, trend, trendRange, trendError, setTrendRange, reload }) {
  const { health = {}, stats = {}, config = {}, logs = [], ok } = snapshot;
  const instances = stats.instances || [];
  const engines = config.engines || [];
  const state = computeStatus(health, stats, ok);
  const [expandedIssue, setExpandedIssue] = useState(null);
  const [feedMaxHeight, setFeedMaxHeight] = useState(null);
  const engineActivityRef = useRef(null);
  const usage = stats.usage || {};
  const syncFeedHeight = useCallback(() => {
    const wrap = engineActivityRef.current;
    if (!wrap || wrap.children.length < 2) return;
    const enginesPanel = wrap.children[0];
    const livePanel = wrap.children[1];
    const sideBySide = Math.abs(enginesPanel.getBoundingClientRect().top - livePanel.getBoundingClientRect().top) < 2;
    if (!sideBySide) {
      setFeedMaxHeight((prev) => (prev === null ? prev : null));
      return;
    }
    const grid = enginesPanel.querySelector(".engine-grid");
    const enginesHeight = grid
      ? grid.getBoundingClientRect().height
      : enginesPanel.getBoundingClientRect().height;
    setFeedMaxHeight((prev) => (Math.abs((prev || 0) - enginesHeight) > 1 ? enginesHeight : prev));
  }, []);
  useEffect(() => {
    syncFeedHeight();
    window.addEventListener("resize", syncFeedHeight);
    let observer;
    const wrap = engineActivityRef.current;
    if (wrap && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(syncFeedHeight);
      for (const child of wrap.children) observer.observe(child);
      const grid = wrap.children[0]?.querySelector(".engine-grid");
      if (grid) observer.observe(grid);
    }
    return () => {
      window.removeEventListener("resize", syncFeedHeight);
      observer?.disconnect();
    };
  }, [syncFeedHeight]);
  useEffect(() => {
    syncFeedHeight();
  }, [feed, syncFeedHeight]);
  return (
    <>
      <section className="overview">
        <section className="panel welcome">
          <div>
            <div className="section-kicker">Live operational overview</div>
            <h1>
              {state.level === "ok"
                ? "Navigator is ready"
                : state.level === "degraded"
                  ? "Navigator needs attention"
                  : "Navigator has a blocking issue"}
            </h1>
          </div>
          <div className={`health-line ${state.level}`}>
            <span className="health-ring" />
            {state.level === "ok"
              ? "All monitored systems are healthy"
              : `${state.issues.length} item${state.issues.length === 1 ? "" : "s"} need attention`}
          </div>
        </section>
        <section className="metrics">
          <Metric
            label="Total searches"
            value={(usage.searches || 0).toLocaleString()}
          />
          <Metric
            label="Total web fetches"
            value={(usage.fetches || 0).toLocaleString()}
          />
          <Metric
            label="Total screenshots"
            value={(usage.screenshots || 0).toLocaleString()}
          />
          <Metric
            label="Total results served"
            value={(usage.resultsServed || 0).toLocaleString()}
          />
          <Metric
            label="Total tool calls"
            value={(usage.toolCalls || 0).toLocaleString()}
          />
        </section>
      </section>
      <RequestActivityTrend
        trend={trend}
        range={trendRange}
        error={trendError}
        setRange={setTrendRange}
      />
      {state.level !== "ok" && (
        <section
          className={`attention show ${state.level === "critical" ? "critical" : ""}`}
        >
          <strong>
            {state.level === "critical" ? "Action needed" : "Heads up"}
          </strong>
          <div className="attention-items">
            {state.issues.slice(0, 4).map((issue, index) => (
              <div
                className={`attention-item${issue.detail?.length ? " expandable" : ""}`}
                key={`${issue.text}-${index}`}
              >
                {issue.detail?.length ? (
                  <button
                    className="attention-toggle"
                    aria-expanded={expandedIssue === index}
                    onClick={() =>
                      setExpandedIssue(expandedIssue === index ? null : index)
                    }
                  >
                    <span className="attention-caret">
                      {expandedIssue === index ? "▾" : "▸"}
                    </span>
                    {issue.text}
                  </button>
                ) : (
                  issue.text
                )}
                {expandedIssue === index && issue.detail?.length ? (
                  <div className="attention-detail">
                    {issue.detail.map((entry, j) => (
                      <div className="attention-error" key={j}>
                        <span className="attention-error-tool">{entry.tool}</span>
                        <span className="attention-error-time">
                          {entry.minutesAgo}m ago
                        </span>
                        <div className="attention-error-msg">{entry.error}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="content-grid">
        <div className="engine-activity" ref={engineActivityRef}>
          <Engines config={config} health={health} stats={stats} reload={reload} />
          <LiveFeed feed={feed} enabledEngines={engines.map((engine) => engine.id)} feedMaxHeight={feedMaxHeight} />
        </div>
        <Drivers health={health} instances={instances} />
        <Runtime health={health} stats={stats} history={history} />
        <Logs logs={logs} />
      </section>
    </>
  );
}
function Runtime({ health, stats, history }) {
  const limiter = health.pageLimiter || {};
  const windows = health.searchWindows || {};
  const cache = stats.cache || {};
  const hits = stats.counters?.cacheHits || 0;
  const misses = stats.counters?.cacheMisses || 0;
  return (
    <Panel title="Activity" sub="capacity, cache and windows">
      <div className="list">
        <Item
          tone={limiter.queued ? "warn" : ""}
          title="Page capacity"
          detail={`${limiter.inUse ?? 0} of ${limiter.maxConcurrentPageOps ?? "?"} slots active${limiter.queued ? ` · ${limiter.queued} waiting` : ""}`}
        />
        <Item
          title="Search windows"
          detail={`${windows.total || 0} open across active search routes`}
        />
        <Item
          title="Cache"
          detail={`${cache.total || 0} entries${hits + misses ? ` · ${Math.round((hits / (hits + misses)) * 100)}% hit rate` : " · no requests cached yet"}`}
        />
        <Item
          title="Server"
          detail={`${formatBytes(stats.memory?.rss)} memory · ${stats.sessions ?? 0} MCP client${stats.sessions === 1 ? "" : "s"}`}
        />
      </div>
      <Trend label="Memory" values={history.memory} color="#2dd4bf" />
      <Trend label="Page slots" values={history.slots} color="#35e07a" />
    </Panel>
  );
}
function Drivers({ health, instances }) {
  const byBackend = new Map(instances.map((item) => [item.backend, item]));
  const browsers = health.browsers || [];
  return (
    <Panel title="Browser drivers" sub="engines, tabs and close timers">
      <div className="list">
        {browsers.map((browser) => {
          const backend = browser.name;
          const instance = byBackend.get(backend);
          const online = Boolean(instance?.connected);
          const defaultDriver = backend === health.backend;
          const detail = online
            ? `${instance.tabs || 0} tabs · pid ${instance.pid ?? "-"} · ${instance.spawns || 0} spawns`
            : defaultDriver
              ? "Default driver is not connected"
              : browser.addOn ? "Add-on — not connected" : "Not started";
          return (
            <div className="item driver-item" key={backend}>
              <Dot tone={online ? "" : defaultDriver ? "err" : "off"} />
              <div className="item-main">
                <div className="item-title">
                  {backend} {defaultDriver && <Pill tone="info">default</Pill>} {browser.addOn && <Pill tone="warn">add-on</Pill>}
                </div>
                <div className="item-detail">{detail}</div>
                {online && (instance.openTabs || []).length > 0 && (
                  <div className="driver-tabs">
                    {(instance.openTabs || []).map((tab, index) => (
                      <div className="driver-tab" key={`${tab.targetId || index}`}>
                        <span className="driver-tab-title" title={tab.url}>
                          {tab.title || tab.url || "Untitled page"}
                        </span>
                        {tab.autoClose ? (
                          <Countdown closesInMs={tab.closesInMs} />
                        ) : (
                          <span className="countdown sticky">sticky</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <Pill tone={online ? "ok" : defaultDriver ? "err" : "off"}>
                {online ? "online" : defaultDriver ? "offline" : "idle"}
              </Pill>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
function Engines({ config, health, stats, reload }) {
  const [resetStatus, setResetStatus] = useState(null);
  const resetEngine = async (engine) => {
    setResetStatus({ engine, text: "resetting..." });
    try {
      await request(engine === "all" ? "/engines/reset/all" : "/engines/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(engine === "all" ? {} : { body: JSON.stringify({ engine }) })
      });
      await reload();
      setResetStatus({ engine, text: "reset." });
    } catch (error) {
      setResetStatus({ engine, text: "failed" });
    }
    setTimeout(() => setResetStatus((current) => current?.engine === engine ? null : current), 1800);
  };
  const circuits = new Map(
    (health.searchRouteCircuitBreakers || []).map((item) => [
      `${item.route}`,
      item,
    ]),
  );
  const attempts = stats.engineAttempts?.byEngine || {};
  const profiles = new Map((stats.engineProfiles || []).map((profile) => [profile.engine, profile]));
  const now = Date.now();
  const warmup = new Set(config.config?.searchRouteWarmupEngines || []);
  const enabled = new Set(config.config?.searchEnabledEngines || []);
  const rateFor = (id) => {
    const period = attempts[id]?.byPeriod?.["24h"] || attempts[id] || {};
    const tried = (period.ok || 0) + (period.fail || 0);
    return tried ? { tried, rate: (period.ok || 0) / tried } : { tried: 0, rate: 0 };
  };
  const schedulingState = (profile) => {
    if (profile.state === "cooling_down") return "cooling_down";
    if (profile.state === "probe") return "probe";
    return "ready";
  };
  const stateRank = { ready: 0, probe: 1, cooling_down: 2 };
  const engines = [...(config.engines || [])].sort((a, b) => {
    const profileA = profiles.get(a.id) || {};
    const profileB = profiles.get(b.id) || {};
    const rankA = stateRank[schedulingState(profileA)] ?? 4;
    const rankB = stateRank[schedulingState(profileB)] ?? 4;
    if (rankA !== rankB) return rankA - rankB;
    return (profileA.rank || Number.MAX_SAFE_INTEGER) - (profileB.rank || Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
  });
  if (!engines.length)
    return (
      <Panel title="Search engines">
        <Empty>No engine registry is available yet.</Empty>
      </Panel>
    );
  const ready = engines.filter((item) => schedulingState(profiles.get(item.id) || {}) === "ready");
  const cooling = engines.filter((item) => schedulingState(profiles.get(item.id) || {}) === "cooling_down");
  const probes = engines.filter((item) => schedulingState(profiles.get(item.id) || {}) === "probe");
  return (
    <Panel
      title="Search engines"
      sub="select_best queue — weighted healthy-route distribution"
    >
      <div className="engine-summary">
        <b>{ready.length}</b> ready · <b>{probes.length}</b> recovery probes · <b>{cooling.length}</b> cooling down
        <button className="button small engine-reset-all" onClick={() => resetEngine("all")} disabled={resetStatus?.engine === "all" && resetStatus.text === "resetting..."}>{resetStatus?.engine === "all" ? resetStatus.text : "reset all"}</button>
      </div>
      <div className="engine-grid">
        {engines.map((engine, index) => {
          const circuit = circuits.get(engine.id);
          const stat = attempts[engine.id] || {};
          const profile = profiles.get(engine.id) || {};
          const schedulerState = schedulingState(profile);
          const attempted = (stat.ok || 0) + (stat.fail || 0);
          const { rate } = rateFor(engine.id);
          let tone = "ok";
          let route = schedulerState;
          if (circuit?.remainingMs > 0) {
            tone = "err";
            route = `open · retry ${Math.ceil(circuit.remainingMs / 1000)}s`;
          } else if (schedulerState === "cooling_down") {
            tone = "err";
            route = `cooling · retry ${formatCountdown(profile.remainingMs)}`;
          } else if (schedulerState === "probe" || circuit?.state === "half_open") {
            tone = "warn";
            route = "recovery probe";
          }
          const pool =
            health.searchWindows?.byEngine?.[
              engine.pool === "shared" ? "_shared" : engine.id
            ];
          const role = warmup.has(engine.id)
            ? "primary"
            : enabled.has(engine.id)
              ? "enabled"
              : "available";
          const pct = Math.round(rate * 100);
          const errMsg = circuit?.lastError || (schedulerState !== "ready" ? profile.lastError : "");
          return (
            <div
              className="engine engine-row"
              key={engine.id}
              title={errMsg || ""}
            >
              <Dot tone={tone === "ok" ? "" : tone} />
              <div className="engine-main">
                <div className="engine-name">
                   <span className="queue-position">{profile.rank || index + 1}</span>
                   {engine.id}
                   <Pill tone={tone}>{route}</Pill>
                  <button className="button small engine-reset" onClick={() => resetEngine(engine.id)} disabled={resetStatus?.engine === engine.id && resetStatus.text === "resetting..."}>{resetStatus?.engine === engine.id ? resetStatus.text : "reset"}</button>
                </div>
                <div className="engine-inline-meta"><span className="feed-backend">{engine.pool || "api"}</span> · {role}</div>
                <div className="ordering-factors">
                  <span title="Scheduler eligibility state — ready means the route can be dispatched right now"><b>{schedulerState.replace("_", " ")}</b> eligibility</span>
                  <span title="Composite score: success rate, result yield, recent stability, failure recency, recovery, and response latency"><b>{Number(profile.score || 0).toFixed(3)}</b> score</span>
                  <span title="Median response time from recent successful searches"><b>{profile.medianLatencyMs ? formatMs(profile.medianLatencyMs) : "unmeasured"}</b> latency</span>
                  <span className={profile.consecutiveFailures ? "score-error" : ""} title="Consecutive failed attempts since the last success"><b>{profile.consecutiveFailures || 0}</b> failure streak</span>
                  <span title="The persisted minimum interval between automatic calls"><b>{formatCountdown(profile.minIntervalMs || 0)}</b> min interval</span>
                  <span title="Time until this route becomes eligible for automatic selection"><b>{profile.remainingMs ? formatCountdown(profile.remainingMs) : "now"}</b> next eligible</span>
                  {schedulerState === "cooling_down" && <span className="score-error" title="Time remaining before this cooling-down route can retry"><b>{formatCountdown(profile.remainingMs)}</b> retry wait</span>}
                  <span title="Attempt tallies: ok = returned results, fail = errored or zero results, skip = never tried (e.g. circuit open)"><b>{stat.ok || 0}/{stat.fail || 0}/{stat.skip || 0}</b> ok/fail/skip</span>
                  <span title={attempted ? `${pct}% success rate over the last 24 hours` : "No search attempts recorded in the last 24 hours"}><b>{attempted ? `${pct}%` : "-"}</b> · 24h</span>
                </div>
                {errMsg && schedulerState !== "ready" && (
                  <div className="engine-route-error" title={errMsg}>{errMsg}</div>
                )}
              </div>
              <div className="engine-stats">
                <b>{stat.results || 0}</b> results
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
function Work({ stats }) {
  const counters = stats.counters || {};
  const period = stats.requests?.byPeriod?.["5m"];
  const attempts = stats.engineAttempts || {};
  return (
    <Panel title="Work completed" sub="since server start">
      <div className="list">
        <Item
          title={`${counters.searches || 0} searches · ${counters.fetches || 0} fetches · ${counters.screenshots || 0} screenshots`}
          detail="Completed since this server started"
        />
        <Item
          tone={period?.err ? "warn" : ""}
          title={`Last 5 minutes: ${period ? `${period.ok} successful / ${period.err} failed` : "no requests"}`}
          detail={`${attempts.total || 0} engine attempts · ${attempts.ok || 0} succeeded · ${attempts.fail || 0} failed`}
        />
      </div>
    </Panel>
  );
}
function buildFeed(entries, pageOps) {
  const preview = (value) => String(value || "").slice(0, 80);
  const requestTarget = (value) => {
    try {
      const url = new URL(value);
      return preview(`${url.host}${url.pathname}${url.search}`);
    } catch {
      return preview(value);
    }
  };
  const devtoolsRequest = (tool, target) => {
    const action = tool === "Target.createTarget" ? "open"
      : tool === "Target.closeTarget" ? "close"
        : tool === "Target.getTargets" ? "list"
          : tool === "Page.navigate" ? "navigate"
            : tool === "web_page_screenshot" ? "capture"
              : tool.startsWith("DOM.") ? "inspect"
                : tool.startsWith("Runtime.") ? "run script in"
                  : tool.startsWith("Input.") ? "interact with"
                    : "use";
    return target ? `${action} ${requestTarget(target)}` : action;
  };
  const rows = [];
  for (const search of entries || []) {
    const attempts = (search.attempts || []).filter((attempt) => attempt.status !== "skip").map((attempt) => ({
      key: attempt.id,
      engine: attempt.engine,
      backend: formatBackend(attempt.backend),
      status: attempt.status || "running",
      response:
        attempt.status === "skip" ? `skipped · ${attempt.error || "scheduler"}`
          : attempt.status === "fail" || attempt.status === "error" ? `failed · ${attempt.error || "request failed"}`
            : attempt.status === "ok" ? `${attempt.result_count || 0} results` : attempt.status || "running",
      duration: attempt.duration_ms != null ? formatMs(attempt.duration_ms) : "",
      error: attempt.error || "",
    }));
    const backends = [...new Set(attempts
      .filter((attempt) => attempt.status === "ok")
      .map((attempt) => attempt.backend)
      .filter((backend) => backend !== "-"))];
    rows.push({
      key: `s-${search.id}`,
      ts: search.ts,
      kind: "search",
      status: search.status || "",
      category: "Web",
      tool: "web_search",
      backend: backends.join("/") || "-",
      requestLabel: "query",
      request: preview(search.query),
      response:
        search.error ? "error" : search.result_count != null ? `${search.result_count} results` : search.status || "running",
      duration: search.duration_ms != null ? formatMs(search.duration_ms) : "",
      error: search.error || "",
      attempts,
    });
  }
  for (const op of pageOps || []) {
    const isDevtools = op.source === "devtools";
    const pageAction = op.tool === "web_page_screenshot" ? "capture" : "fetch";
    const isRunning = op.status === "running";
    rows.push({
      key: `p-${op.id}`,
      ts: op.ts,
      kind: isDevtools ? "devtools" : "page_op",
      status: op.status || (op.ok ? "ok" : "fail"),
      category: isDevtools ? "Dev" : "Web",
      tool: op.tool || "page",
      backend: formatBackend(op.backend),
      requestLabel: isDevtools ? "tab" : "page",
      request: isDevtools ? devtoolsRequest(op.tool || "", op.url) : `${pageAction}: ${requestTarget(op.url)}`,
      response: isRunning
        ? "in progress…"
        : op.error
          ? "error"
          : op.response_chars
            ? `${Number(op.response_chars).toLocaleString()} chars`
            : "- chars",
      duration: op.duration_ms != null ? formatMs(op.duration_ms) : isRunning ? "…" : "",
      error: op.error || "",
    });
  }
  return rows.sort((a, b) => Number(b.ts) - Number(a.ts));
}
function LiveFeed({ feed, enabledEngines, feedMaxHeight }) {
  const [showWeb, setShowWeb] = useState(true);
  const [showDevtools, setShowDevtools] = useState(true);
  const [newKeys, setNewKeys] = useState(() => new Set());
  const knownKeys = useRef(null);
  const enabledEngineIds = new Set(enabledEngines);
  const rows = (feed || [])
    .map((entry) =>
      entry.attempts
        ? {
            ...entry,
            attempts: entry.attempts.filter((attempt) =>
              enabledEngineIds.has(attempt.engine),
            ),
          }
        : entry,
    )
    .filter((entry) => (entry.kind === "devtools" ? showDevtools : showWeb));
  useEffect(() => {
    const currentKeys = new Set(rows.map((entry) => entry.key));
    if (!knownKeys.current) {
      if (feed?.length) knownKeys.current = currentKeys;
      return;
    }
    const added = new Set([...currentKeys].filter((key) => !knownKeys.current.has(key)));
    if (added.size) {
      setNewKeys(added);
    }
    knownKeys.current = currentKeys;
  }, [feed]);
  return (
    <Panel
      title="Live activity"
      sub={
        <span className="feed-filters">
          <label className="feed-toggle">
            <input
              type="checkbox"
              checked={showWeb}
              onChange={(event) => setShowWeb(event.target.checked)}
            />
            Web
          </label>
          <label className="feed-toggle">
            <input
              type="checkbox"
              checked={showDevtools}
              onChange={(event) => setShowDevtools(event.target.checked)}
            />
            DevTools
          </label>
        </span>
      }
    >
      {rows.length ? (
        <div className="feed" style={feedMaxHeight ? { maxHeight: feedMaxHeight } : undefined}>
          <table className="activity-table">
            <colgroup>
              <col className="activity-time" />
              <col className="activity-tool" />
              <col className="activity-response" />
              <col className="activity-duration" />
            </colgroup>
            <tbody>
              {rows.map((entry) => {
                const tone = entry.status === "ok" ? "ok" : entry.status === "fail" || entry.status === "error" ? "fail" : entry.status === "running" ? "running" : "";
                return (
                  <tr
                    className={`activity-row ${tone} ${newKeys.has(entry.key) ? "activity-new" : ""}`}
                    key={entry.key || `${entry.kind}-${entry.ts}`}
                  >
                    <td className="feed-time">
                      <span className="feed-time-top">
                        <b>{formatRelativeTime(entry.ts)}</b>
                        <span className="feed-kind">{entry.category}</span>
                      </span>
                      <small>{formatTime(entry.ts)}</small>
                    </td>
                    <td className="activity-tool-cell">
                      <span className="feed-tool">
                        {entry.tool} <span className="feed-backend">{entry.backend || "-"}</span>
                      </span>
                      <span className="feed-request" title={entry.request}>{entry.requestLabel || "request"}: {entry.request || "-"}</span>
                      {entry.attempts?.length ? (
                        <span className="feed-attempts">
                          {entry.attempts.map((attempt) => (
                            <span
                              className={`feed-attempt ${attempt.status === "ok" ? "ok" : attempt.status === "skip" ? "skip" : attempt.status === "fail" || attempt.status === "error" ? "fail" : ""}`}
                              key={attempt.key}
                              title={attempt.error || undefined}
                            >
                              {attempt.engine} <span className="feed-backend">{attempt.backend}</span>: {attempt.response}
                              {attempt.duration ? ` · ${attempt.duration}` : ""}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td className={`feed-response ${entry.error ? "feed-error" : ""}`} title={entry.error || entry.response}>
                      {entry.error ? "error" : entry.response}
                    </td>
                    <td className="feed-duration">{entry.duration}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          No activity recorded yet. Searches and engine attempts will stream
          here as they happen.
        </Empty>
      )}
    </Panel>
  );
}
const ERROR_FILTERS = ["All", "Web Browsing", "DevTools", "System"];
function Logs({ logs }) {
  const [filter, setFilter] = useState("All");
  const counts = { All: logs.length };
  ERROR_FILTERS.slice(1).forEach((family) => {
    counts[family] = logs.filter((entry) => classifyError(entry).family === family).length;
  });
  const filtered =
    filter === "All"
      ? logs
      : logs.filter((entry) => classifyError(entry).family === filter);
  return (
    <Panel title="Recent errors" sub="latest tool failures" wide>
      <div className="log-filter">
        {ERROR_FILTERS.map((name) => (
          <button
            key={name}
            className={filter === name ? "active" : ""}
            onClick={() => setFilter(name)}
          >
            {name} <b>{counts[name]}</b>
          </button>
        ))}
      </div>
      {filtered.length ? (
        <div className="logs">
          {filtered.map((entry, index) => {
            const info = classifyError(entry);
            return (
              <div className="log-entry" key={`${entry.ts}-${index}`}>
                <div className="log-row">
                  <b>{entry.tool || entry.level || "error"}</b>
                  <Pill
                    tone={
                      info.critical
                        ? "err"
                        : info.expected
                          ? "off"
                          : "info"
                    }
                  >
                    {info.expected
                      ? "expected input"
                      : info.critical
                        ? "critical"
                        : info.family}
                  </Pill>
                  <span>{entry.ts || ""}</span>
                </div>
                <div className="item-detail">
                  {entry.error || entry.message || "Unknown error"}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>No tool errors match this filter.</Empty>
      )}
    </Panel>
  );
}

export { REQUEST_SERIES, requestValue, ActivityLineChart, RequestActivityTrend, computeStatus, StatusView, Runtime, Drivers, Engines, Work, buildFeed, LiveFeed, Logs };
