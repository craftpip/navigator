import { formatBytes } from "../../lib/format.js";
import { Panel, Item, Trend } from "../../components/ui.jsx";

export function Runtime({ health, stats, history }) {
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
