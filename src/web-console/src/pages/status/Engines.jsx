import { useState } from "react";
import { request } from "../../lib/request.js";
import { formatMs, formatCountdown } from "../../lib/format.js";
import { Panel, Empty, Dot, Pill } from "../../components/ui.jsx";

export function Engines({ config, health, stats, reload }) {
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
                <div className="engine-inline-meta"><span className="feed-backend">{(engine.pool === "shared" ? "engine" : engine.pool) || "api"}</span> · {role}</div>
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
