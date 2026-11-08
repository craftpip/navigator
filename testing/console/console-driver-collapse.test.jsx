// @vitest-environment jsdom
//
// HELD, NOT IN tests/ ON PURPOSE.
//
// Every jsdom test fails to collect in this repo: tests/setup.js imports
// node builtins, which vitest 4.1.10 rejects under the jsdom environment
// ("No such built-in module: node:"). That also breaks the in-flight
// tests/modal-dismiss.test.jsx. Sitting under tests/ this file would show up
// as a NEW red suite, so it lives here until the harness is fixed — see
// infinite.md "Needs your call". To run it afterwards:
//   npx vitest run --root . testing/console/console-driver-collapse.test.jsx
// (after either fixing tests/setup.js or passing --config without setupFiles).
//
//
// Plan 49 — collapsible Browser-driver rows.
//
// The console polls every 2s, so a naive "derive expanded from props"
// implementation would collapse whatever the user just opened. These tests
// pin the three things that make the affordance usable and durable:
//
//   1. the disclosure chevron renders, and only shows a glyph when the row
//      actually has tabs (an empty span keeps the status Dot aligned)
//   2. clicking flips aria-expanded + the open/collapsed class
//   3. state survives a re-render with new props (the poll), and a row that
//      loses its tabs is not expandable
//
// Rendering is done against the real component — the earlier implementation
// shipped .driver-toggle-chevron CSS with no element to style, so a
// stylesheet-only check would have passed while the affordance was missing.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Drivers } from "../../src/web-console/src/pages/status/Drivers.jsx";
import { PopupProvider } from "../src/web-console/src/components/popup.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/web-console/src/lib/request.js", () => ({
  request: vi.fn().mockResolvedValue({}),
}));

let container;
let root;

function browser(name, extra = {}) {
  return { name, type: "inbuilt", status: "connected", ...extra };
}

function instance(name, { tabs = [], connected = true } = {}) {
  return {
    backend: name,
    connected,
    tabs: tabs.length,
    openTabs: tabs.map((t, i) => ({ targetId: `t${i}`, title: t, url: `https://${t}/` })),
  };
}

function render(props) {
  act(() => {
    root.render(
      <PopupProvider>
        <Drivers {...props} />
      </PopupProvider>,
    );
  });
}

function rows() {
  return [...container.querySelectorAll(".driver-item")].map((row) => {
    const toggle = row.querySelector(".driver-toggle");
    const chevron = row.querySelector(".driver-toggle-chevron");
    return {
      row,
      toggle,
      chevron,
      backend: toggle?.querySelector(".item-title")?.textContent?.trim().split(/\s+/)[0] || "",
      expandable: row.classList.contains("expandable"),
      expandedClass: row.classList.contains("expanded"),
      glyph: chevron?.textContent ?? null,
      disabled: toggle?.disabled ?? null,
      ariaExpanded: toggle?.getAttribute("aria-expanded"),
      ariaControls: toggle?.getAttribute("aria-controls"),
      tabsClass: row.querySelector(".driver-tabs")?.className ?? null,
      tabCount: row.querySelectorAll(".driver-tab").length,
    };
  });
}

function click(toggle) {
  act(() => {
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const baseProps = () => ({
  health: { backend: "chromium", browsers: [browser("chromium"), browser("cloakbrowser", { type: "cdp" })] },
  instances: [instance("chromium", { tabs: ["GitHub — craftpip", "about:blank"] }), instance("cloakbrowser")],
  reload: vi.fn(),
  height: null,
});

describe("plan 49 — collapsible driver rows", () => {
  it("renders the chevron on every row so the status Dot stays aligned", () => {
    render(baseProps());
    const list = rows();
    expect(list).toHaveLength(2);
    for (const r of list) expect(r.chevron).not.toBeNull();
  });

  it("shows a glyph only on the row that has tabs, and disables the other", () => {
    render(baseProps());
    const [withTabs, withoutTabs] = rows();
    expect(withTabs.backend).toBe("chromium");
    expect(withTabs.expandable).toBe(true);
    expect(withTabs.glyph).toBe("▸");
    expect(withTabs.disabled).toBe(false);
    expect(withTabs.ariaControls).toBe("driver-tabs-chromium");

    expect(withoutTabs.expandable).toBe(false);
    expect(withoutTabs.glyph).toBe("");
    expect(withoutTabs.disabled).toBe(true);
    // Not an expandable region — the ARIA attributes are omitted, not "false".
    expect(withoutTabs.ariaExpanded).toBeNull();
    expect(withoutTabs.ariaControls).toBeNull();
  });

  it("flips aria-expanded, the chevron glyph and the open/collapsed class on click", () => {
    render(baseProps());
    const first = rows()[0];
    expect(first.ariaExpanded).toBe("false");
    expect(first.expandedClass).toBe(false);
    expect(first.tabsClass).toContain("collapsed");
    expect(first.tabCount).toBe(2);

    click(first.toggle);
    const open = rows()[0];
    expect(open.ariaExpanded).toBe("true");
    expect(open.glyph).toBe("▾");
    expect(open.expandedClass).toBe(true);
    expect(open.tabsClass).toContain("open");

    click(open.toggle);
    const closed = rows()[0];
    expect(closed.ariaExpanded).toBe("false");
    expect(closed.glyph).toBe("▸");
    expect(closed.tabsClass).toContain("collapsed");
  });

  it("keeps the open row open across a poll that brings new data", () => {
    const props = baseProps();
    render(props);
    click(rows()[0].toggle);
    expect(rows()[0].ariaExpanded).toBe("true");

    // Same component instance, new props — this is what the 2s poll does.
    render({ ...props, instances: [instance("chromium", { tabs: ["GitHub — craftpip", "about:blank", "new"] })] });
    const afterPoll = rows()[0];
    expect(afterPoll.ariaExpanded).toBe("true");
    expect(afterPoll.glyph).toBe("▾");
    expect(afterPoll.tabCount).toBe(3);
  });

  it("collapses the row per browser, not globally", () => {
    const props = baseProps();
    render({
      ...props,
      instances: [instance("chromium", { tabs: ["a"] }), instance("cloakbrowser", { tabs: ["b"] })],
    });
    const list = rows();
    expect(list.every((r) => r.expandable)).toBe(true);
    click(list[0].toggle);
    const [a, b] = rows();
    expect(a.ariaExpanded).toBe("true");
    expect(b.ariaExpanded).toBe("false");
  });

  it("stops being expandable once the row loses its tabs, and clicking is then inert", () => {
    const props = baseProps();
    render(props);
    click(rows()[0].toggle);
    expect(rows()[0].ariaExpanded).toBe("true");

    // Tab closed in the meantime.
    render({ ...props, instances: [instance("chromium", { tabs: [] }), instance("cloakbrowser")] });
    const now = rows()[0];
    expect(now.expandable).toBe(false);
    expect(now.glyph).toBe("");
    expect(now.disabled).toBe(true);
    expect(now.tabsClass).toBeNull();
  });

  it("keeps the relay PIN prompt visible and outside the collapsible block", () => {
    render({
      health: {
        backend: "chromium",
        browsers: [browser("chromium"), browser("macbook", { type: "navigator-cdp", status: "auth_pending" })],
      },
      instances: [instance("chromium"), instance("macbook", { connected: false })],
      reload: vi.fn(),
      height: null,
    });
    const pending = rows().find((r) => r.backend === "macbook");
    expect(pending.expandable).toBe(false);
    expect(pending.disabled).toBe(true);
    // The pending browser has no tabs, so it renders no .driver-tabs at all —
    // the PIN UI lives in item-main and can never be collapsed away.
    expect(pending.tabsClass).toBeNull();
    expect(pending.toggle.textContent).toContain("PIN");
  });
});
