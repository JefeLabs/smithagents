/**
 * Zustand stores created with create() are module singletons, so their state
 * survives across tests in the same file. Every store registers its own
 * restore-to-initial function here, and the global test setup calls
 * resetAllStores() before each test.
 */
const resetters = new Set<() => void>();

export function registerStoreReset(fn: () => void): void {
  resetters.add(fn);
}

export function resetAllStores(): void {
  for (const reset of resetters) reset();
}
