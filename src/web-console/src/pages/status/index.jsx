import { useCallback, useEffect, useRef, useState } from "react";
import { Metric, Loading } from "../../components/ui.jsx";
import { computeStatus, RequestActivityTrend } from "./ActivityChart.jsx";
import { Drivers } from "./Drivers.jsx";
import { Engines } from "./Engines.jsx";
import { Runtime } from "./Runtime.jsx";
import { LiveFeed, buildFeed } from "./LiveFeed.jsx";
import { Logs } from "./Logs.jsx";

function StatusView({ snapshot, ready, history, toggleVnc, vncBusy, feed, trend, trendRange, trendError, setTrendRange, reload }) {
  const { health = {}, stats = {}, config = {}, logs = [], ok } = snapshot;
  const instances = stats.instances || [];
  const engines = config.engines || [];
  const state = computeStatus(health, stats, ok);
  const [expandedIssue, setExpandedIssue] = useState(null);
  const [feedMaxHeight, setFeedMaxHeight] = useState(null);
  const engineActivityRef = useRef(null);
  const trendDriversRef = useRef(null);
  const [driverHeight, setDriverHeight] = useState(null);
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
  const syncDriverHeight = useCallback(() => {
    const wrap = trendDriversRef.current;
    if (!wrap || wrap.children.length < 2) return;
    const trendPanel = wrap.children[0];
    const driversPanel = wrap.children[1];
    const sideBySide = Math.abs(trendPanel.getBoundingClientRect().top - driversPanel.getBoundingClientRect().top) < 2;
    if (!sideBySide) {
      setDriverHeight((prev) => (prev === null ? prev : null));
      return;
    }
    const h = trendPanel.getBoundingClientRect().height;
    if (h < 10) return;
    setDriverHeight((prev) => (Math.abs((prev || 0) - h) > 1 ? h : prev));
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
  useEffect(() => {
    syncDriverHeight();
    window.addEventListener("resize", syncDriverHeight);
    let observer;
    const wrap = trendDriversRef.current;
    if (wrap && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(syncDriverHeight);
      for (const child of wrap.children) observer.observe(child);
    }
    return () => {
      window.removeEventListener("resize", syncDriverHeight);
      observer?.disconnect();
    };
  }, [syncDriverHeight]);
  useEffect(() => {
    syncDriverHeight();
  }, [trend, health?.browsers, stats?.instances, syncDriverHeight]);
  return ready ? (
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
      <section className="trend-drivers" ref={trendDriversRef}>
        <RequestActivityTrend
          trend={trend}
          range={trendRange}
          error={trendError}
          setRange={setTrendRange}
        />
        <Drivers health={health} instances={instances} reload={reload} height={driverHeight} />
      </section>
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
        <Runtime health={health} stats={stats} history={history} />
        <Logs logs={logs} />
      </section>
    </>
  ) : (
    <Loading>Loading dashboard…</Loading>
  );
}

export { StatusView, buildFeed };
