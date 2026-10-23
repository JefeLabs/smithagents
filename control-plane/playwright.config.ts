import { defineConfig } from "@playwright/test";

/**
 * Passkey e2e. The web server is NOT auto-started: a faithful run drives its own
 * required-mode broker and serves the SPA at a cloud-like host (see e2e/
 * passkey-login.spec.ts header). E2E_BASE_URL points at that served SPA.
 *
 * Runs on the installed Google Chrome (`channel: "chrome"`), not a downloaded
 * Playwright Chromium build: no `playwright install` needed, and Playwright
 * upgrades don't download a new browser. Chrome supports the CDP WebAuthn
 * virtual authenticator the passkey spec uses. The trade-off is that the test
 * runs on whatever version Chrome has auto-updated to.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:1420",
  },
  projects: [{ name: "chrome", use: { browserName: "chromium", channel: "chrome" } }],
});
