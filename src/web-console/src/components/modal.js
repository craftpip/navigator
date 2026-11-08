import { useCallback, useEffect, useRef, useState } from "react";

// Exit-animation duration for every console modal. Must match the
// `modal-*-out` animation length in style.css so the panel finishes
// fading before it unmounts.
export const MODAL_CLOSE_MS = 160;

// Shared dismiss behavior for every console modal:
// - Escape closes (unless disabled, e.g. while saving)
// - backdrop/X/Cancel all funnel through `requestClose`, which plays the
//   CSS exit animation (`is-closing`) before invoking `onClose`
// - background scroll is locked while the modal is mounted
// Pass `active: false` for inline modals whose host component stays mounted
// while the modal is hidden (e.g. the API-key editor) so Escape and the
// scroll lock only apply while the modal is actually shown.
export function useModalDismiss({ onClose, disabled, active = true }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (disabled || !active) return;
    if (closing) return;
    const fn = onCloseRef.current;
    if (!fn) return;
    setClosing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setClosing(false);
      fn();
    }, MODAL_CLOSE_MS);
  }, [disabled, active, closing]);

  // A reopen must cancel a close that is still animating — otherwise the
  // stale timer slams the fresh modal shut (and the fresh modal flashes the
  // exit animation). Call it from every open path.
  const cancelClose = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    if (closing) setClosing(false);
  }, [closing]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Same protection for remount-style reopens (e.g. selecting another
  // activity entry): when `active` flips false→true, drop any exit state
  // synchronously during render — a passive effect would run after paint,
  // one frame too late, flashing the exit animation on the fresh modal.
  const [prevActive, setPrevActive] = useState(active);
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) {
      clearTimeout(timer.current);
      timer.current = null;
      if (closing) setClosing(false);
    }
  }

  useEffect(() => {
    if (disabled || !active) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled, requestClose]);

  useEffect(() => {
    if (!active) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);

  return { closing, requestClose, cancelClose };
}
