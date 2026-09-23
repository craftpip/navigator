import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const PopupContext = createContext(null);

export function usePopup() {
  const context = useContext(PopupContext);
  if (!context) throw new Error("usePopup must be used within <PopupProvider>");
  return context;
}

function defaultTitle(kind) {
  if (kind === "confirm") return "Confirm";
  if (kind === "prompt") return "Prompt";
  return "Notice";
}

export function PopupProvider({ children }) {
  const [state, setState] = useState(null); // { kind, message, options, value, resolve }

  const open = useCallback((kind, message, options) => {
    return new Promise((resolve) => {
      setState({
        kind,
        message,
        options: options || {},
        value: options && options.defaultValue != null ? String(options.defaultValue) : "",
        resolve,
      });
    });
  }, []);

  const popup = useMemo(
    () => ({
      alert: (message, options) => open("alert", message, options),
      confirm: (message, options) => open("confirm", message, options),
      prompt: (message, options) => open("prompt", message, options),
    }),
    [open],
  );

  const cancelValue = (kind) => (kind === "prompt" ? null : false);
  const close = useCallback((result) => {
    setState((current) => {
      if (current) {
        current.resolve(result);
        return null;
      }
      return current;
    });
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(state.kind === "alert" ? true : cancelValue(state.kind));
      } else if (event.key === "Enter" && state.kind !== "confirm") {
        event.preventDefault();
        close(state.kind === "prompt" ? state.value : true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state, close]);

  if (!state) return <PopupContext.Provider value={popup}>{children}</PopupContext.Provider>;

  const title = state.options.title || defaultTitle(state.kind);
  const cancelLabel = state.options.cancelLabel || "Cancel";
  const okLabel = state.options.okLabel || "OK";
  const dismiss = (result) => close(result);

  return (
    <PopupContext.Provider value={popup}>
      {children}
      <div
        className="popup-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismiss(state.kind === "alert" ? true : cancelValue(state.kind));
        }}
      >
        <div className="popup" role="alertdialog" aria-modal="true" aria-label={title}>
          <div className="popup-head">
            <b>{title}</b>
            <button type="button" className="clear" onClick={() => dismiss(state.kind === "alert" ? true : cancelValue(state.kind))}>
              Close
            </button>
          </div>
          <div className="popup-body">{state.message}</div>
          {state.kind === "prompt" && (
            <input
              className="popup-input"
              value={state.value}
              onChange={(event) => setState((current) => ({ ...current, value: event.target.value }))}
              autoFocus
            />
          )}
          <div className="popup-actions">
            {state.kind !== "alert" && (
              <button type="button" className="button" onClick={() => dismiss(cancelValue(state.kind))}>
                {cancelLabel}
              </button>
            )}
            <button type="button" className="button primary" onClick={() => dismiss(state.kind === "prompt" ? state.value : true)}>
              {okLabel}
            </button>
          </div>
        </div>
      </div>
    </PopupContext.Provider>
  );
}