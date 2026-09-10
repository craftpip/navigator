import { useState } from "react";
import { classifyError } from "../../lib/request.js";
import { Panel, Empty, Pill } from "../../components/ui.jsx";

export const ERROR_FILTERS = ["All", "Web Browsing", "DevTools", "System"];

export function Logs({ logs }) {
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
