import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatBytes, formatUptime } from "../lib/format.js";
import { useNarrow } from "../lib/hooks.js";
import logo from "../../../../navigator-logo.png";

export function Layout({
  children,
  mode,
  setMode,
  title = "CONSOLE",
  telemetry = {},
  paused,
  setPaused,
  vnc,
  toggleVnc,
  vncBusy,
}) {
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("navigator-theme") ||
      (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("navigator-theme", theme);
  }, [theme]);
  const status = telemetry.ok ? "ok" : "off";
  const narrow = useNarrow(720);
  return (
    <main className="app">
      <header>
        <div className="hdr-left">
          <a className="logo" href="/console">
            <img className="logo-img" src={logo} alt="Navigator alligator logo" />
            NAVIGATOR <span>{title}</span>
          </a>
          {title === "CONSOLE" && (
            <>
              <div className="hdr-item">
                uptime <b>{formatUptime(telemetry.stats?.uptimeSeconds)}</b>
              </div>
              <div className="hdr-item">
                mem <b>{formatBytes(telemetry.stats?.memory?.rss)}</b>
              </div>
              <div className="hdr-item">
                sessions <b>{telemetry.stats?.sessions ?? "-"}</b>
              </div>
            </>
          )}
        </div>
        <div className="hdr-spacer" />
        <div className="hdr-right">
          {setMode ? (
            <div className="mode-switch">
              <button
                className={mode === "status" ? "active" : ""}
                onClick={() => setMode("status")}
              >
                Status
              </button>
              <button
                className={mode === "manage" ? "active" : ""}
                onClick={() => setMode("manage")}
              >
                Manage
              </button>
              <button
                className={mode === "tools" ? "active" : ""}
                onClick={() => setMode("tools")}
              >
                Web tools
              </button>
              <button
                className={mode === "keys" ? "active" : ""}
                onClick={() => setMode("keys")}
              >
                API keys
              </button>
              <button
                className={mode === "hints" ? "active" : ""}
                onClick={() => setMode("hints")}
              >
                Domain hints
              </button>
            </div>
          ) : (
            <a className="button" href="/console">
              Back to console
            </a>
          )}
          <button
            className="button theme-toggle"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            title={`Theme: ${theme}`}
            aria-label={`Theme: ${theme}`}
          >
            {theme === "light" ? (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="8" cy="8" r="3.5" fill="currentColor" />
                <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <line x1="8" y1="1.5" x2="8" y2="3" />
                  <line x1="8" y1="13" x2="8" y2="14.5" />
                  <line x1="1.5" y1="8" x2="3" y2="8" />
                  <line x1="13" y1="8" x2="14.5" y2="8" />
                  <line x1="3.5" y1="3.5" x2="4.5" y2="4.5" />
                  <line x1="11.5" y1="11.5" x2="12.5" y2="12.5" />
                  <line x1="12.5" y1="3.5" x2="11.5" y2="4.5" />
                  <line x1="4.5" y1="11.5" x2="3.5" y2="12.5" />
                </g>
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M13.6 9.8A5.6 5.6 0 0 1 6.2 2.4a5.6 5.6 0 1 0 7.4 7.4z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
          {toggleVnc && (
            vncBusy ? (
              <button className="button" disabled>
                Working...
              </button>
            ) : vnc?.running ? (
              <div className="remote-desktop-actions" role="group" aria-label="Remote Desktop">
                <button
                  className="button"
                  onClick={() =>
                    window.open(
                      `http://${location.hostname}:${vnc.novncPort}/vnc.html`,
                      "_blank",
                      "noopener",
                    )
                  }
                >
                  {narrow ? "Open" : "Open Remote Desktop"}
                </button>
                <button className="button danger" onClick={toggleVnc}>
                  {narrow ? "Close" : "Close Remote Desktop"}
                </button>
              </div>
            ) : (
              <button className="button" onClick={toggleVnc}>
                {narrow ? "VNC" : "Enable Remote Desktop"}
              </button>
            )
          )}
          {title === "CONSOLE" && setPaused && (
            <button
              className={`button live-toggle ${paused ? "paused" : status}`}
              onClick={() => setPaused(!paused)}
              title="Pause live polling"
            >
              <i />
              {paused ? "PAUSED" : telemetry.ok ? "LIVE 2s" : "OFFLINE"}
              {paused ? "[▶]" : "[⏸]"}
            </button>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}

export function ImmediateTooltip() {
  const [tooltip, setTooltip] = useState(null);
  const [side, setSide] = useState("right");
  const tooltipRef = useRef(null);
  useEffect(() => {
    const moveTitle = (element) => {
      const text = element.getAttribute("title");
      if (text) element.setAttribute("data-tooltip", text);
      element.removeAttribute("title");
    };
    const moveTitles = (root) => {
      if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
      if (root.nodeType === Node.ELEMENT_NODE && root.hasAttribute("title")) moveTitle(root);
      root.querySelectorAll?.("[title]").forEach(moveTitle);
    };
    const getTarget = (node) => node instanceof Element ? node.closest("[data-tooltip], [title]") : null;
    const show = (event) => {
      const element = getTarget(event.target);
      if (!element) return setTooltip(null);
      if (element.hasAttribute("title")) moveTitle(element);
      const text = element.getAttribute("data-tooltip");
      if (!text) return setTooltip(null);
      setTooltip({ text, x: event.clientX, y: event.clientY });
    };
    const hide = (event) => {
      const element = getTarget(event.target);
      if (element?.contains(event.relatedTarget)) return;
      setTooltip(null);
    };
    const move = (event) => {
      const element = getTarget(event.target);
      if (!element) return;
      setTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
    };
    const focus = (event) => {
      const element = getTarget(event.target);
      if (!element) return;
      if (element.hasAttribute("title")) moveTitle(element);
      const text = element.getAttribute("data-tooltip");
      if (!text) return;
      const rect = element.getBoundingClientRect();
      setTooltip({ text, x: rect.left + rect.width / 2, y: rect.bottom });
    };
    moveTitles(document);
    const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => {
      if (mutation.type === "attributes") moveTitle(mutation.target);
      else mutation.addedNodes.forEach(moveTitles);
    }));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
    document.addEventListener("pointerover", show, true);
    document.addEventListener("pointerout", hide, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", show, true);
      document.removeEventListener("pointerout", hide, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return;
    const rect = tooltipRef.current.getBoundingClientRect();
    const nextSide = tooltip.x + rect.width + 12 > window.innerWidth - 8 ? "left" : "right";
    if (nextSide !== side) setSide(nextSide);
  }, [tooltip, side]);
  return tooltip ? <div ref={tooltipRef} className={`immediate-tooltip ${side}`} role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div> : null;
}
