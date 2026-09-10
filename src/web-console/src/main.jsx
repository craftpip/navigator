import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { mergeErrorLogs, request } from "./lib/request.js";
import { modeFromPath, pathForMode } from "./lib/routing.js";
import { Layout, ImmediateTooltip } from "./components/Layout.jsx";
import { Keys } from "./pages/keys/index.jsx";
import { Manage } from "./pages/manage/index.jsx";
import { Hints } from "./pages/hints/index.jsx";
import { StatusView, buildFeed } from "./pages/status/index.jsx";
import { Tools } from "./pages/tools/index.jsx";

const POLL_MS = 2000;

function App() {
  const [mode, setMode] = useState(() => modeFromPath(location.pathname));
  const [trendRange, setTrendRange] = useState(() => {
    const range = new URLSearchParams(location.search).get("range");
    return ["minutes", "hour", "day", "week"].includes(range) ? range : "day";
  });
  const [trend, setTrend] = useState(null);
  const [trendError, setTrendError] = useState("");
  const [snapshot, setSnapshot] = useState({});
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [feed, setFeed] = useState([]);
  const [history, setHistory] = useState({
    memory: [],
    slots: [],
    requests: [],
  });
  const [vncBusy, setVncBusy] = useState(false);
  const feedSince = useRef(0);
  const feedOpsSince = useRef(0);
  const loadingRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const navigate = (next) => {
    const path = pathForMode(next);
    if (location.pathname !== path) {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new Event("navigator:pathchange"));
    }
    setMode(next);
  };
  const updateTrendQuery = (nextRange) => {
    const params = new URLSearchParams(location.search);
    params.set("range", nextRange);
    params.delete("engine");
    window.history.replaceState({}, "", `${location.pathname}?${params}`);
  };
  const changeTrendRange = (nextRange) => {
    setTrendRange(nextRange);
    updateTrendQuery(nextRange);
  };
  // Full snapshot (status dashboard + explicit reloads) vs light heartbeat.
  // Only the status view reads stats/config/logs/activity, and /stats alone
  // can take longer than POLL_MS (CDP round-trips per backend) — so other
  // modes refresh just /health (LIVE badge + VNC state) and skip the rest.
  // loadingRef serializes ticks: without it a slow /stats overlaps the next
  // interval and poll cycles pile up faster than they resolve.
  const load = async (full = true) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      if (!full) {
        try {
          const health = await request("/health");
          setSnapshot((current) => ({ ...current, health, ok: true }));
        } catch {
          setSnapshot((current) => ({ ...current, ok: false }));
        }
        return;
      }
      try {
        const [health, stats, config, logPayload, activity] = await Promise.all([
          request("/health"),
          request("/stats"),
          request("/console/config"),
          request("/console/logs?n=20"),
          request(`/stats/activity?since=${feedSince.current}&sinceOps=${feedOpsSince.current}&limit=100&pageOps=1`),
        ]);
        setFeed((current) => {
          const merged = [...current];
          for (const row of buildFeed(activity.entries, activity.pageOps)) {
            const existing = merged.findIndex((entry) => entry.key === row.key);
            if (existing === -1) merged.push(row);
            else merged[existing] = row;
          }
          return merged.sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, 200);
        });
        for (const entry of activity.entries || []) {
          feedSince.current = Math.max(feedSince.current, Number(entry.id) || 0);
        }
        for (const op of activity.pageOps || []) {
          feedOpsSince.current = Math.max(feedOpsSince.current, Number(op.id) || 0);
        }
        setSnapshot({
          health,
          stats,
          config,
          logs: mergeErrorLogs(logPayload.entries || [], stats.requests?.recentErrors || []),
          ok: true,
        });
        setHistory((current) => ({
          memory: [...current.memory, stats.memory?.rss || 0].slice(-60),
          slots: [...current.slots, health.pageLimiter?.inUse || 0].slice(-60),
          requests: [
            ...current.requests,
            stats.requests?.byPeriod?.["5m"]?.total || 0,
          ].slice(-60),
        }));
      } catch {
        setSnapshot((current) => ({ ...current, ok: false }));
      }
    } finally {
      if (full) setReady(true);
      loadingRef.current = false;
    }
  };
  // Initial snapshot is always full so the header telemetry (uptime/mem/
  // sessions) is populated on every page. Non-status modes then idle on the
  // light heartbeat; returning to the status dashboard refetches a full
  // snapshot (its data goes stale while other modes idle).
  useEffect(() => {
    load(true);
  }, [mode]);
  useEffect(() => {
    if (paused) return undefined;
    const interval = setInterval(() => {
      if (!document.hidden) load(modeRef.current === "status");
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [paused]);
  useEffect(() => {
    if (mode !== "status" || paused) return undefined;
    let cancelled = false;
    const loadTrend = async () => {
      try {
        const payload = await request(`/stats/activity-trend?range=${encodeURIComponent(trendRange)}`);
        if (!cancelled) {
          setTrend(payload);
          setTrendError("");
        }
      } catch (error) {
        if (!cancelled) setTrendError(error.message || "Request failed");
      }
    };
    loadTrend();
    const interval = setInterval(() => {
      if (!document.hidden) loadTrend();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode, paused, trendRange]);
  useEffect(() => {
    const onPop = () => setMode(modeFromPath(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const toggleVnc = async () => {
    setVncBusy(true);
    try {
      await request("/console/vnc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: snapshot.health?.vnc?.running ? "disable" : "enable",
        }),
      });
      await load();
    } finally {
      setVncBusy(false);
    }
  };
  return <>
    <Layout
      mode={mode}
      setMode={navigate}
      telemetry={snapshot}
      paused={paused}
      setPaused={setPaused}
      vnc={snapshot.health?.vnc}
      toggleVnc={toggleVnc}
      vncBusy={vncBusy}
    >
      {mode === "status" ? (
        <StatusView
          snapshot={snapshot}
          ready={ready}
          history={history}
          toggleVnc={toggleVnc}
          vncBusy={vncBusy}
          feed={feed}
          trend={trend}
          trendRange={trendRange}
          trendError={trendError}
          setTrendRange={changeTrendRange}
          reload={load}
        />
      ) : mode === "manage" ? (
        <Manage config={snapshot.config || {}} reload={load} />
      ) : mode === "tools" ? (
        <Tools />
      ) : mode === "keys" ? (
        <Keys />
      ) : mode === "hints" ? (
        <Hints />
      ) : (
        <StatusView
          snapshot={snapshot}
          ready={ready}
          history={history}
          toggleVnc={toggleVnc}
          vncBusy={vncBusy}
          feed={feed}
          trend={trend}
          trendRange={trendRange}
          trendError={trendError}
          setTrendRange={changeTrendRange}
          reload={load}
        />
      )}
    </Layout>
    <ImmediateTooltip />
  </>;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
