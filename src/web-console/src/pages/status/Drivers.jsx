import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/request.js";
import { Panel, Dot, Pill, Countdown } from "../../components/ui.jsx";
import { BrowserEditModal } from "../manage/BrowserEditModal.jsx";
import { parseBrowsersEntries, serializeBrowsersEntries } from "../manage/browser-utils.js";
import { BROWSER_TYPE_LABEL } from "../manage/constants.js";

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text);
    return true;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

function RelayAuth({ browser }) {
  const [left, setLeft] = useState(Math.max(0, (browser.pinExpiresAt || 0) - Date.now()));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const update = () => setLeft(Math.max(0, (browser.pinExpiresAt || 0) - Date.now()));
    update();
    setCopied(false);
    const tick = setInterval(update, 1000);
    return () => clearInterval(tick);
  }, [browser.pinExpiresAt]);
  // When PIN is expired, don't show the "expired — reconnect" UI — just
  // hide and let the driver fall back to its previous paired/disconnected state.
  if (left <= 0) return null;
  return (
    <div className="relay-auth">
      <div className="relay-auth-head">
        <strong>Incoming browser authorization required</strong>
        <span className="relay-auth-exp">
          {`${Math.ceil(left / 1000)}s left`}
        </span>
      </div>
      <div className="relay-auth-msg">
        A connection request from <b>{browser.name}</b> is waiting. Enter this PIN in the Chrome extension popup within 60 seconds:
      </div>
      <div className="relay-auth-code">
        <span className="relay-pin">{browser.pin || "······"}</span>
        <button
          type="button"
          className="relay-copy"
          onClick={() => {
            if (browser.pin && copyText(browser.pin)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function Drivers({ health, instances, reload, height }) {
  const byBackend = new Map(instances.map((item) => [item.backend, item]));
  const browsers = health.browsers || [];
  const [forgetting, setForgetting] = useState(null);
  const [menuOpen, setMenuOpen] = useState(null);
  const [editing, setEditing] = useState(null); // { browser, loading, entry, error }
  const [saveNotice, setSaveNotice] = useState("");
  const [expanded, setExpanded] = useState(() => ({}));
  const toggle = (backend) => setExpanded((prev) => ({ ...prev, [backend]: !prev[backend] }));
  const prevTabsRef = useRef({});
  const menuRef = useRef(null);

  // Close the driver menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(null);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMenuOpen(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const openEdit = async (browser) => {
    setMenuOpen(null);
    setSaveNotice("");
    setEditing({ browser, loading: true, entry: null, error: "" });
    try {
      const payload = await request("/console/config");
      const configured = parseBrowsersEntries(payload?.configValues?.BROWSERS || "[]");
      let entry = configured.find((e) => e.name === browser.name);
      if (!entry) {
        entry = {
          name: browser.name || "",
          role: Array.isArray(browser.role) ? browser.role : ["default"],
          type: browser.type || "navigator-cdp",
          plugin: browser.plugin || "auto",
          cdpUrl: browser.cdpUrl || "",
        };
      }
      setEditing({ browser, loading: false, entry, error: "" });
    } catch (err) {
      setEditing({ browser, loading: false, entry: null, error: err?.message || "Failed to load browser config" });
    }
  };

  const handleEntrySave = async (nextEntry) => {
    const payload = await request("/console/config");
    const configured = parseBrowsersEntries(payload?.configValues?.BROWSERS || "[]");
    const originalName = editing?.browser?.name;
    const idx = configured.findIndex((e) => e.name === originalName);
    const next = idx >= 0 ? configured.map((e, i) => (i === idx ? nextEntry : e)) : [...configured, nextEntry];
    const result = await request("/console/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: { BROWSERS: serializeBrowsersEntries(next) } }),
    });
    setSaveNotice(
      result.restartRequired?.includes("BROWSERS")
        ? "Browsers apply after a container restart — restart navigator to activate."
        : "Saved. Browsers are active immediately — no restart needed.",
    );
    if (reload) await reload();
  };

  return (
    <Panel title="Browser drivers" sub="engines, tabs and close timers" style={height ? { height } : undefined}>
      <div className="list">
        {browsers.map((browser) => {
          const backend = browser.name;
          const instance = byBackend.get(backend);
          const online = Boolean(instance?.connected);
          const defaultDriver = backend === health.backend;
          const isRelay = browser.type === "navigator-cdp";
          const relayState = isRelay ? browser.status : null;
          const pending = relayState === "auth_pending";
          const tabs = instance?.tabs || 0;
          // Consistent detail — same for inbuilt / CDP / relay, no role/endpoint clutter
          const detail = pending
            ? "Waiting for PIN authorization — unpaired incoming request"
            : online
              ? `${tabs} tab${tabs === 1 ? "" : "s"}`
              : isRelay
                ? browser.paired
                  ? "Offline — paired, awaiting connection"
                  : "Offline — not paired — pair from the extension to connect"
                : defaultDriver
                  ? "Offline — default driver not connected"
                  : "Offline — not connected";
          const dotTone = pending ? "warn" : online ? "" : "off";
          const statusPill = pending ? <Pill tone="warn">PIN required</Pill> : null;
          const typePill = browser.type ? <Pill tone="off" title={browser.type}>{BROWSER_TYPE_LABEL[browser.type] || browser.type}</Pill> : null;
          // The detected connecting browser for navigator-cdp relays (extension sends its platform)
          const detectedPill = browser.type === "navigator-cdp" && browser.plugin && browser.plugin !== "auto"
            ? <Pill tone="ok">{browser.plugin}</Pill>
            : null;
          const rawTabs = instance?.openTabs || [];
          // Anti-flicker cache: a single slow/timeout poll can briefly report
          // 0 tabs (e.g. Lightpanda title lookup). Reuse the last non-empty
          // list only while fresh (10s TTL) so genuine closes/restarts don't
          // leave ghost tabs under an honest "0 tabs" row text.
          if (rawTabs.length > 0) prevTabsRef.current[backend] = { tabs: rawTabs, at: Date.now() };
          const cached = prevTabsRef.current[backend];
          const cacheFresh = cached && (Date.now() - cached.at < 10000);
          if (!cacheFresh && cached) delete prevTabsRef.current[backend];
          const tabsToShow = rawTabs.length > 0 ? rawTabs : (online && cacheFresh ? cached.tabs : []);
          const hasTabs = tabsToShow.length > 0 && online;
          const isExpanded = Boolean(expanded[backend]);
          return (
            <div className={`item driver-item${hasTabs ? " expandable" : ""}${isExpanded && hasTabs ? " expanded" : ""}`} key={backend}>
              <button
                className="driver-toggle"
                aria-expanded={hasTabs ? isExpanded : undefined}
                aria-controls={hasTabs ? `driver-tabs-${backend}` : undefined}
                disabled={!hasTabs}
                onClick={() => hasTabs && toggle(backend)}
                title={hasTabs ? (isExpanded ? "Hide tabs" : `Show ${tabsToShow.length} tabs`) : undefined}
              >
                <Dot tone={dotTone} />
                <div className="item-main">
                  <div className="item-title">
                    {backend} {typePill} {statusPill} {detectedPill}
                  </div>
                  <div className="item-detail">{detail}</div>
                  {pending && <RelayAuth browser={browser} />}
                </div>
              </button>
              <div className="driver-actions">
                {!pending && browser.type !== "inbuilt" && (
                  <div className="driver-menu" ref={menuOpen === backend ? menuRef : null}>
                    <button
                      type="button"
                      className="driver-menu-btn"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen === backend}
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(menuOpen === backend ? null : backend);
                      }}
                      title="Driver actions"
                    >
                      ⋮
                    </button>
                    {menuOpen === backend && (
                      <div className="driver-menu-popup" role="menu">
                        {isRelay && (
                          <button
                            type="button"
                            className="menu-item"
                            disabled={forgetting === backend}
                            onClick={async () => {
                              if (!confirm(`Forget browser "${backend}"? This clears the pairing — a new PIN will be required to reconnect.`)) {
                                setMenuOpen(null);
                                return;
                              }
                              setForgetting(backend);
                              try {
                                await request("/console/relay/forget", {
                                  method: "POST",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({ name: backend })
                                });
                                if (reload) await reload();
                              } catch {}
                              setForgetting(null);
                              setMenuOpen(null);
                            }}
                            title={browser.paired ? "Clear pairing for this browser" : "Remove this entry"}
                          >
                            {forgetting === backend ? "…" : "Forget"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="menu-item"
                          onClick={() => openEdit(browser)}
                          title="Edit this browser's entry in the .env config"
                        >
                          Edit…
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {hasTabs ? (
                <div id={`driver-tabs-${backend}`} className={`driver-tabs ${isExpanded ? "open" : "collapsed"}`} aria-hidden={!isExpanded}>
                  <div className="driver-tabs-inner">
                    <div className="driver-tabs-header">
                      <span>Tab</span>
                      <span>Lifetime</span>
                    </div>
                    {tabsToShow.map((tab, index) => (
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
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {editing && (
        editing.loading ? (
          <div className="api-key-modal-backdrop" role="presentation">
            <div className="api-key-modal" role="dialog" aria-modal="true">
              <div className="api-key-modal-head"><b>Edit {editing.browser.name}</b></div>
              <div className="item-detail">Loading browser config…</div>
            </div>
          </div>
        ) : editing.error ? (
          <div className="api-key-modal-backdrop" role="presentation">
            <div className="api-key-modal" role="dialog" aria-modal="true">
              <div className="api-key-modal-head">
                <div><b>Edit {editing.browser.name}</b></div>
                <button className="clear" onClick={() => setEditing(null)} aria-label="Close">×</button>
              </div>
              <div className="field-error">{editing.error}</div>
              <div className="api-key-modal-actions">
                <button className="button small" onClick={() => setEditing(null)}>Close</button>
              </div>
            </div>
          </div>
        ) : (
          <BrowserEditModal
            title={editing.entry?.name ? `Edit ${editing.entry.name}` : "Edit browser"}
            subtitle="Changes are written to .env — effective after a navigator restart."
            key={editing.browser.name}
            initial={editing.entry}
            lockType
            footer={saveNotice ? <div className="api-key-modal-footer">{saveNotice}</div> : null}
            onClose={() => { setEditing(null); setSaveNotice(""); }}
            onSave={handleEntrySave}
          />
        )
      )}
    </Panel>
  );
}
