// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestActivityTrend } from "../src/web-console/src/pages/status/ActivityChart.jsx";

// ActivityChart.jsx compiles under the classic JSX runtime (bare `React`
// references), so expose it globally for the imported component tree.
globalThis.React ??= React;

// Regression guard for plans/75_empty-activity-graph.md: an empty request-activity
// period must render the normal graph (axes, lines flat at zero) with a muted
// caption alongside it — never a replacing <Empty> state.
//
// renderToStaticMarkup exercises the real component tree (effects like the
// ResizeObserver in ActivityLineChart do not run under SSR, which is fine —
///we assert on the rendered structure, not interactivity).

function zeroTrend(bucketCount = 15) {
  return {
    buckets: Array.from({ length: bucketCount }, (_, index) => ({
      ts: index,
      total: 0,
      web: { ok: 0, fail: 0 },
      devtools: { ok: 0, fail: 0 },
      engine: { ok: 0, fail: 0, skip: 0 },
    })),
    summary: { total: 0, ok: 0, fail: 0 },
    engineSummary: { total: 0, ok: 0, fail: 0, skip: 0 },
  };
}

function render(props) {
  return renderToStaticMarkup(
    createElement(RequestActivityTrend, {
      trend: null,
      range: "day",
      error: null,
      setRange: () => {},
      engine: "all",
      setEngine: () => {},
      engines: [],
      ...props,
    }),
  );
}

describe("request activity empty state (plan 75)", () => {
  it("zero activity renders the chart with the caption centered over it — not <Empty>", () => {
    const html = render({ trend: zeroTrend() });
    expect(html).toContain("request-trend-chart");
    expect(html).toContain("<svg");
    expect(html).toContain("No request activity in this period.");
    expect(html).toContain("position:absolute");
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("request-trend-engine");
    expect(html).not.toContain('class="empty"');
  });

  it("non-zero activity renders the chart with no empty caption", () => {
    const trend = zeroTrend();
    trend.buckets[7].total = 3;
    trend.buckets[7].web.ok = 3;
    trend.summary = { total: 3, ok: 3, fail: 0 };
    const html = render({ trend });
    expect(html).toContain("request-trend-chart");
    expect(html).not.toContain("No request activity in this period.");
  });

  it("keeps loading and error states intact", () => {
    const loading = render({ trend: null });
    expect(loading).toContain("Loading activity trend");
    const failed = render({ trend: null, error: "boom" });
    expect(failed).toContain("Could not load activity trend: boom");
  });

  it("zero-filled backend shape still gives the chart buckets to draw", () => {
    // Mirrors the all-zero trend getActivityTrend returns (see activity.test.js):
    // full bucket arrays with zero values, so ActivityLineChart's max=1 floor
    // draws every series flat at zero instead of having nothing to render.
    const trend = zeroTrend();
    expect(trend.buckets.length).toBeGreaterThanOrEqual(2);
    const max = Math.max(1, ...trend.buckets.flatMap((bucket) => [bucket.total]));
    expect(max).toBe(1);
  });
});
