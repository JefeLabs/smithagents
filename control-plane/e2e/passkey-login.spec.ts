// Passkey enroll → app-render e2e via Chrome DevTools Protocol's WebAuthn
// virtual authenticator (no real hardware).
//
// FAITHFUL-RUN PREREQUISITES (run by hand — see the limitation note below):
//   Local run:
//   1. Stop the live tmux `smith-broker` on 7790 first, then start a broker in required mode with a THROWAWAY auth file, never your real one:
//        SMITH_BROKER_AUTH_FILE=$(mktemp -d)/broker-auth.json pnpm run serve   (in broker/)
//      Its first run prints http://localhost:1420/#invite=XXXX-XXXX; INVITE_CODE is that code.
//   2. The SPA at http://localhost:1420 (the page's hostname is also the broker's, so the
//      session cookie is same-site). E2E_BASE_URL=http://localhost:1420.
//   Cloud run: a required-mode broker whose webOrigin equals the SPA's origin
//      (SMITH_BROKER_WEB_ORIGIN, SMITH_BROKER_RPID) with the SPA served at that SAME host;
//      mint an invite with
//        curl -s -XPOST https://<cloud-host>/auth/invites -H "authorization: Bearer $TOK"
//   3. pnpm exec playwright install chromium   (browser binary)
//
// Then: E2E_BASE_URL=http://localhost:1420 (or https://<cloud-host>) INVITE_CODE=<code> pnpm exec playwright test
import { expect, test } from "@playwright/test";

test.skip(
  !process.env.INVITE_CODE,
  "requires a required-mode broker + SPA on a passkey-capable host + INVITE_CODE (see header)",
);

test("enroll with an invite, then the app renders", async ({ page }) => {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await page.getByRole("button", { name: /i have an invite/i }).click();
  await page.getByPlaceholder("XXXX-XXXX").fill(process.env.INVITE_CODE!);
  await page.getByPlaceholder(/edwin/i).fill("e2e-edwin");
  await page.getByRole("button", { name: /create passkey/i }).click();

  // After enroll the cookie is set and AuthGate re-queries /auth/me → app mounts.
  await expect(page.getByText(/roster|sessions|the app/i).first()).toBeVisible({ timeout: 10_000 });
});
