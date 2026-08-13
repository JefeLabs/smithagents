import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetAllStores } from "../stores/reset";

// Stabilization pass (2026-08-13): findBy*/waitFor default to a 1s deadline,
// and under full-suite load a lazy Suspense chunk (DocStage, DashboardsStage)
// can take longer than that just to import — the "Unable to find region
// Document" flake class. A PASSING query still resolves the moment it
// matches; only genuinely-failing waits pay the longer deadline.
configure({ asyncUtilTimeout: 5_000 });

/**
 * This jsdom environment runs on an opaque origin, so it exposes no
 * localStorage, and Node's own global is unconfigured without a flag. That is
 * only a problem because `audioStore` reads the persisted mute preference at
 * MODULE-EVAL time — inside the `create()` call — which happens while a test
 * file's imports resolve, before any `beforeEach` could install a stub. Any
 * test that so much as transitively imports the store would throw on load.
 *
 * Hoisted so it lands before this file's own imports, and left writable so a
 * suite that needs to control the stored value can still stub over it.
 */
vi.hoisted(() => {
  const map = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;

  /**
   * jsdom implements no `matchMedia`, and `@heroui-pro/react`'s barrel reaches
   * `sheet/use-scale-background` which calls it at MODULE-EVAL time — so importing
   * ANY Pro component throws while a test file's imports resolve, exactly like the
   * audioStore case above. Hoisted for the same reason.
   *
   * Deliberately inert: never matches, and its listeners are no-ops. A suite that
   * cares about media state stubs over it (see useTheme.test.tsx) rather than
   * inheriting a guess from here.
   */
  if (typeof globalThis.matchMedia !== "function") {
    globalThis.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof globalThis.matchMedia;
  }

  /**
   * jsdom implements no `ResizeObserver`. `Sidebar.Content` wraps HeroUI's
   * `ScrollShadow`, which observes its own size to decide when to show the
   * fade — mounting any `Sidebar` throws without this, same failure mode as
   * `matchMedia` above.
   */
  if (typeof globalThis.ResizeObserver !== "function") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  /**
   * jsdom implements `Window.prototype.scrollTo` (as a "not implemented" console
   * stub) but never `Element.prototype.scrollTo` at all. `ChatConversation`'s
   * stick-to-bottom behavior calls `scrollTo` on its own scroll container ref
   * inside a `requestAnimationFrame` callback, so the throw lands async, after
   * the render that triggered it — any test that mounts a `Transcript` with
   * messages hits it, not just Transcript's own suite.
   */
  if (typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = () => {};
  }

  /**
   * jsdom implements no Pointer Capture API at all. `Sheet`'s drag-to-dismiss
   * gesture calls `setPointerCapture` from its `onPointerDown` handler on
   * every press (not just drags on the handle) — so any test that clicks
   * inside a mounted `Sheet` throws, even ones that never touch dragging.
   */
  if (typeof Element.prototype.setPointerCapture !== "function") {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
  }

  /**
   * jsdom implements no layout, so `getClientRects` is missing on Range and
   * returns nothing useful on Element. Tiptap's BubbleMenu and FloatingMenu
   * measure the selection to place themselves on every selection change — the
   * throw lands as an UNHANDLED error after the test has already passed, which
   * is how a green suite still exits non-zero.
   */
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
  if (typeof Element.prototype.getClientRects !== "function") {
    Element.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  }
});

beforeEach(() => resetAllStores());
afterEach(() => cleanup());
