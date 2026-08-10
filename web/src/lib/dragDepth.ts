/**
 * Drag-highlight helper. A drop zone that wraps children (a textarea, buttons) fires `dragleave` on the
 * wrapper every time the pointer crosses onto a child, which would flicker the "drop here" highlight off
 * while the pointer is still inside the zone. This predicate keeps the highlight stable: it is only truly
 * leaving when the pointer moved to something the zone does NOT contain (or left the window entirely).
 *
 * Stateless by design — a dragenter/dragleave counter can desync permanently (highlight stuck on) when the
 * zone's children re-render mid-drag, which they do here because toggling the highlight itself swaps the
 * wrapper's classes. A containment check cannot desync.
 *
 * `relatedTarget` is the element the pointer entered: null when it left the window, otherwise a DOM node.
 */
export function isLeavingDropZone(zone: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return relatedTarget === null || !zone.contains(relatedTarget as Node);
}
