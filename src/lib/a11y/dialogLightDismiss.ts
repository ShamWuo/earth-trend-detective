/**
 * Dialog light-dismiss fallback helper for browsers without native
 * `<dialog closedby="any">` support.
 *
 * Uses pointer press-and-release bounding-box hit-testing instead of
 * `event.target === dialog` so dragging text outside onto the backdrop or
 * clicking dialog padding/gaps never accidentally dismisses a modal, and
 * keyboard-synthesized click events at (0, 0) never false-trigger dismiss.
 */

export interface BoundingBoxRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function isPointOutsideRect(
  clientX: number,
  clientY: number,
  rect: BoundingBoxRect,
): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
  return (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  );
}

export function attachDialogLightDismissFallback(
  dialog: HTMLDialogElement | null,
  onDismiss: () => void,
  contentEl?: HTMLElement | null,
): () => void {
  if (!dialog) return () => {};

  let pressedOutside = false;

  const getBounds = (): BoundingBoxRect => {
    const target = contentEl ?? dialog;
    return target.getBoundingClientRect();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!dialog.open || event.button !== 0) {
      pressedOutside = false;
      return;
    }
    pressedOutside = isPointOutsideRect(event.clientX, event.clientY, getBounds());
  };

  const handleClick = (event: MouseEvent) => {
    if (!dialog.open) {
      pressedOutside = false;
      return;
    }
    // Keyboard activations (Enter/Space) synthesize click events at (0, 0);
    // detail === 0 marks non-pointer activation so we never dismiss accidentally.
    if (event.detail === 0) {
      pressedOutside = false;
      return;
    }
    const releasedOutside = isPointOutsideRect(
      event.clientX,
      event.clientY,
      getBounds(),
    );
    const shouldDismiss = pressedOutside && releasedOutside;
    pressedOutside = false;
    if (shouldDismiss) {
      onDismiss();
    }
  };

  dialog.addEventListener("pointerdown", handlePointerDown);
  dialog.addEventListener("click", handleClick);

  return () => {
    dialog.removeEventListener("pointerdown", handlePointerDown);
    dialog.removeEventListener("click", handleClick);
  };
}
