import { defineConfig } from "@playwright/test";

/**
 * Passkey e2e. The web server is NOT auto-started: a faithful run drives its own
 * required-mode broker and serves the SPA at a cloud-like host (see e2e/
 * passkey-login.spec.ts header). E2E_BASE_URL points at that served SPA.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:1420",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
