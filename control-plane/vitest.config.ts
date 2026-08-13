import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    // Stabilization pass (2026-08-13): the flaky files were never racing app
    // logic — they were starving. Isolated, the worst offenders run 0.5–1.5s
    // (react-aria forms driven by real userEvent sequences); under a full
    // parallel suite on this machine they multiply 3–4× and blow through the
    // 5s default. These ceilings are for STARVATION, not permission for slow
    // tests — a genuine hang still dies, just later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
