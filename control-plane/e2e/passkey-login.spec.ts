// Passkey enroll → app-render e2e via Chrome DevTools Protocol's WebAuthn
// virtual authenticator (no real hardware).
//
// FAITHFUL-RUN PREREQUISITES (run by hand — see the limitation note below):
//   1. A broker in required mode whose webOrigin equals the SPA's origin:
//        SMITH_BROKER_AUTH=required SMITH_BROKER_TOKEN=$TOK \
//        SMITH_BROKER_WEB_ORIGIN=https://<cloud-host> SMITH_BROKER_RPID=<cloud-host> \
//        BROKER_TEXT_PORT=7906 npm run serve   (in broker/)
//   2. The SPA built and served at that SAME cloud host (so isCloud() is true and
//      CLOUD_MODE gates — under localhost/127.0.0.1 the gate is a passthrough and
//      no login screen ever renders). E2E_BASE_URL points here.
//   3. Mint an invite:
//        curl -s -XPOST https://<cloud-host>/auth/invites -H "authorization: Bearer $TOK"
//      and pass it as INVITE_CODE.
//   4. pnpm exec playwright install chromium   (browser binary)
//
// Then: E2E_BASE_URL=https://<cloud-host> INVITE_CODE=<code> pnpm exec playwright test
import { expect, test } from "@playwright/test";

test.skip(!process.env.INVITE_CODE, "requires a required-mode broker + cloud-host SPA + INVITE_CODE (see header)");

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
