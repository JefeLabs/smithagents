import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetAllStores } from "../stores/reset";

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
});

beforeEach(() => resetAllStores());
afterEach(() => cleanup());
