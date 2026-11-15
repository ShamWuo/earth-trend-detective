/**
 * Keyboard focus trap helpers for native `<dialog>` elements so `Tab` and
 * `Shift+Tab` wrap cleanly among visible modal controls and closing restores
 * focus to the triggering element.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function getDialogFocusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return candidates.filter((el) => {
    if (el.closest("[hidden], [inert]")) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") {
      return false;
    }
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export function trapDialogTabKey(
  dialog: HTMLDialogElement | null,
  event: { key: string; shiftKey: boolean; preventDefault: () => void }
): void {
  if (!dialog || !dialog.open || event.key !== "Tab") return;
  const focusables = getDialogFocusableElements(dialog);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;

  if (event.shiftKey) {
    if (!active || !dialog.contains(active) || active === first || active === dialog) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (!active || !dialog.contains(active) || active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreOpenerFocus(opener: HTMLElement | null): void {
  if (!opener) return;
  requestAnimationFrame(() => {
    if (opener.isConnected && typeof opener.focus === "function") {
      opener.focus({ preventScroll: true });
    }
  });
}
