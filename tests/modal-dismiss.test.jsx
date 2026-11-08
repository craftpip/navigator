// @vitest-environment jsdom
import { act } from "react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODAL_CLOSE_MS, useModalDismiss } from "../src/web-console/src/components/modal.js";
import { PopupProvider, usePopup } from "../src/web-console/src/components/popup.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Mirrors pages/keys/index.jsx: the host stays mounted, the modal is inline,
// and the open paths re-assert identical values on a rapid reopen.
function KeysLikeHost({ api, onClose }) {
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const { closing, requestClose, cancelClose } = useModalDismiss({
    onClose: () => {
      setModal(null);
      onClose();
    },
    disabled: saving,
    active: modal !== null,
  });
  useEffect(() => {
    api.current = {
      open: () => {
        cancelClose();
        setModal("create");
      },
      close: () => requestClose(),
      setSaving,
      backdrop: () => document.querySelector(".api-key-modal-backdrop"),
    };
  });
  if (!modal) return null;
  return (
    <div className={`api-key-modal-backdrop${closing ? " is-closing" : ""}`}>
      <div className="api-key-modal" />
    </div>
  );
}

// Mirrors components/ActivityDetailModal.jsx: always mounted, visibility
// driven by an `active` prop that toggles.
function ToggleHost({ api, onClose }) {
  const [show, setShow] = useState(true);
  const { closing, requestClose } = useModalDismiss({ onClose, active: show });
  useEffect(() => {
    api.current = {
      requestClose,
      setShow,
      backdrop: () => document.querySelector(".api-key-modal-backdrop"),
    };
  });
  if (!show) return null;
  return (
    <div className={`api-key-modal-backdrop${closing ? " is-closing" : ""}`}>
      <div className="api-key-modal" />
    </div>
  );
}

function PopupHarness({ api }) {
  const popup = usePopup();
  useEffect(() => {
    api.current = popup;
  });
  return null;
}

function mount(node) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(node);
  });
  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      el.remove();
    },
  };
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("useModalDismiss", () => {
  let api;
  let onClose;
  let host;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    api = { current: null };
    onClose = vi.fn();
    host = mount(<KeysLikeHost api={api} onClose={onClose} />);
  });

  afterEach(() => {
    host.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("plays the exit animation, then closes after MODAL_CLOSE_MS", () => {
    act(() => {
      api.current.open();
    });
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop");
    act(() => {
      api.current.close();
    });
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop is-closing");
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(MODAL_CLOSE_MS);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.current.backdrop()).toBeNull();
  });

  it("rapid reopen after close keeps the modal open (no stale-timer kill)", () => {
    act(() => {
      api.current.open();
    });
    act(() => {
      api.current.close();
    });
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop is-closing");
    // Reopen 50ms into the 160ms exit — values are identical, so without an
    // explicit cancel this would bail out and the stale timer would kill it.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => {
      api.current.open();
    });
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop");
  });

  it("Escape closes, and disabled blocks Escape", () => {
    act(() => {
      api.current.open();
    });
    act(() => {
      api.current.setSaving(true);
    });
    pressEscape();
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop");
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      api.current.setSaving(false);
    });
    pressEscape();
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop is-closing");
    act(() => {
      vi.advanceTimersByTime(MODAL_CLOSE_MS);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("useModalDismiss with toggled active", () => {
  let api;
  let onClose;
  let host;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    api = { current: null };
    onClose = vi.fn();
    host = mount(<ToggleHost api={api} onClose={onClose} />);
  });

  afterEach(() => {
    host.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("hide + reshow during the exit cancels the close", () => {
    act(() => {
      api.current.requestClose();
    });
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop is-closing");
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => {
      api.current.setShow(false);
    });
    act(() => {
      api.current.setShow(true);
    });
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(api.current.backdrop()?.className).toBe("api-key-modal-backdrop");
  });
});

describe("PopupProvider", () => {
  let api;
  let host;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    api = { current: null };
    host = mount(
      <PopupProvider>
        <PopupHarness api={api} />
      </PopupProvider>,
    );
  });

  afterEach(() => {
    host.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("opening a new popup while one is closing settles the old one as cancelled", async () => {
    let first;
    act(() => {
      first = api.current.confirm("old");
    });
    expect(document.querySelector(".popup")).not.toBeNull();
    pressEscape(); // starts closing the confirm
    expect(document.querySelector(".popup-backdrop")?.className).toBe("popup-backdrop is-closing");
    let second;
    act(() => {
      second = api.current.alert("new");
    });
    const seen = {};
    first.then((value) => {
      seen.first = value;
    });
    second.then((value) => {
      seen.second = value;
    });
    await act(async () => {
      vi.advanceTimersByTime(MODAL_CLOSE_MS + 50);
    });
    expect(seen.first).toBe(false);
    expect(seen.second).toBe(true);
    expect(document.querySelector(".popup-backdrop.is-closing")).toBeNull();
    expect(document.querySelector(".popup")).not.toBeNull();
  });
});
