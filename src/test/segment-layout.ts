/**
 * A jsdom stand-in for the layout a segmented control needs to measure itself.
 *
 * jsdom lays nothing out, so every element reports an all-zero rect and `useSlidingIndicator`
 * measures nothing at all — which is the fallback path, not the interesting one. This gives the
 * control the boxes a real browser would have given it, in the coordinates a browser reports them
 * in: a container away from the viewport origin and with a border, and segments whose declared
 * *local* positions are projected into viewport space through a scale. Both the container-relative
 * subtraction and the scale division therefore have to be right for a fixture's declared position
 * to come back out.
 *
 * A segment declares its own box with `data-stub-left` / `data-stub-width`; without those it is a
 * uniform segment placed by its position among its button siblings. Anything that is not part of a
 * segmented control keeps reporting zeroes.
 */

/** The width every stubbed segment gets when a fixture does not declare its own. */
export const STUB_SEGMENT_WIDTH = 50;
/** Where the stubbed container sits in the viewport — deliberately not at the origin. */
const CONTAINER_VIEWPORT_LEFT = 300;
/** The stubbed container's border, which sits between its rect and the pill's origin. */
const CONTAINER_BORDER = 1;
/** The stubbed container's layout width, against which its rect reveals the ancestor scale. */
const CONTAINER_LAYOUT_WIDTH = 400;

/** Scale a stubbed ancestor transform is applying; 1 unless a test says otherwise. */
let stubScale = 1;

/** Put the stubbed control inside an ancestor scaled by `scale` (a Modal entrance, say). */
export function setSegmentScale(scale: number): void {
  stubScale = scale;
}

/** A container is any element with segment buttons directly inside it. */
function isSegmentContainer(element: HTMLElement): boolean {
  return Array.from(element.children).some((child) => child.tagName === 'BUTTON');
}

/** Install the stub. Call it per test, and undo it with {@link restoreSegmentLayout}. */
export function stubSegmentLayout() {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      if (isSegmentContainer(this)) {
        return rect(CONTAINER_VIEWPORT_LEFT, CONTAINER_LAYOUT_WIDTH * stubScale);
      }
      const index = segmentIndex(this);
      if (index < 0) return rect(0, 0);
      const left =
        this.dataset.stubLeft !== undefined ? Number(this.dataset.stubLeft) : index * STUB_SEGMENT_WIDTH;
      const width =
        this.dataset.stubWidth !== undefined ? Number(this.dataset.stubWidth) : STUB_SEGMENT_WIDTH;
      return rect(CONTAINER_VIEWPORT_LEFT + (left + CONTAINER_BORDER) * stubScale, width * stubScale);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isSegmentContainer(this) ? CONTAINER_LAYOUT_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientLeft', {
    configurable: true,
    get(this: HTMLElement) {
      return isSegmentContainer(this) ? CONTAINER_BORDER : 0;
    },
  });
}

/** The slice of `DOMRect` the hook reads. */
function rect(left: number, width: number) {
  return { x: left, y: 0, left, top: 0, right: left + width, bottom: 0, width, height: 0 };
}

/** Position of `element` among its `<button>` siblings, or -1 if it is not one. */
function segmentIndex(element: HTMLElement): number {
  if (element.tagName !== 'BUTTON') return -1;
  const peers = Array.from(element.parentElement?.children ?? []).filter(
    (child) => child.tagName === 'BUTTON',
  );
  return peers.indexOf(element);
}

/** Back to jsdom's own answer: no layout, every rect zero. */
export function restoreSegmentLayout() {
  stubScale = 1;
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value() {
      return rect(0, 0);
    },
  });
  for (const property of ['offsetWidth', 'clientLeft']) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get() {
        return 0;
      },
    });
  }
}
