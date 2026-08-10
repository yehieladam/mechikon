/**
 * dragDepth — the drop-zone leave predicate that keeps the drag highlight from flickering over children.
 * Runs under the "node" vitest env with lightweight mocks (no DOM dependency): the predicate only needs a
 * `contains` method on the zone, so we fake it rather than pull in jsdom.
 */
import { describe, expect, it } from "vitest";
import { isLeavingDropZone } from "./dragDepth";

/** A fake zone whose `contains` recognizes a fixed set of "child" nodes. */
function fakeZone(children: readonly object[]): HTMLElement {
  return {
    contains: (node: Node | null) => node !== null && children.includes(node as unknown as object),
  } as unknown as HTMLElement;
}

describe("isLeavingDropZone", () => {
  it("does NOT leave when the pointer moves onto a child of the zone", () => {
    const child = {} as unknown as EventTarget;
    const zone = fakeZone([child]);
    expect(isLeavingDropZone(zone, child)).toBe(false);
  });

  it("leaves when the pointer moves to an element outside the zone", () => {
    const outside = {} as unknown as EventTarget;
    const zone = fakeZone([{}]); // a different child; `outside` is not contained
    expect(isLeavingDropZone(zone, outside)).toBe(true);
  });

  it("leaves when relatedTarget is null (pointer left the window)", () => {
    const zone = fakeZone([{}]);
    expect(isLeavingDropZone(zone, null)).toBe(true);
  });
});
