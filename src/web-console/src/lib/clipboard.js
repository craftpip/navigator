// Copy text to the clipboard from any page, including plain-HTTP LAN pages.
//
// navigator.clipboard only exists in a secure context (https:// or localhost);
// the console is usually opened as http://<lan-ip>:1994, where it is undefined
// and every copy button silently failed. Fall back to a temporary textarea +
// document.execCommand("copy"), which browsers still allow inside a click
// handler on insecure origins. Returns true when the copy succeeded.
export async function copyToClipboard(text) {
  const value = String(text ?? "");
  if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied / document not focused — try the fallback.
    }
  }
  return legacyCopy(value);
}

function legacyCopy(value) {
  if (typeof document === "undefined") return false;
  const previous = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed", top: "0", left: "0", width: "1px", height: "1px",
    padding: "0", border: "0", opacity: "0", pointerEvents: "none",
  });
  // Mount next to the clicked control so a modal's focus trap does not steal
  // focus back before the copy runs.
  const host = previous && previous !== document.body && previous.parentElement ? previous.parentElement : document.body;
  host.appendChild(textarea);
  let ok = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  try { previous?.focus?.({ preventScroll: true }); } catch {}
  return ok;
}
