import { Panel, Item } from "../../components/ui.jsx";

export function Work({ stats }) {
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
