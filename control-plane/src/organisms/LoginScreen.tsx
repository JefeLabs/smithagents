import { Button } from "@heroui/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { beginEnroll, EnrollError, finishEnroll, login } from "../api/auth";
import { isCloud } from "../api/origin";
import { FormTextField } from "../molecules/form";

interface InviteForm {
  code: string;
  name: string;
}

const MESSAGES: Record<string, string> = {
  "bad-code": "That invite code is invalid or expired.",
  "ceremony-failed": "Passkey setup was cancelled or failed.",
};
function messageFor(err: unknown): string {
  if (err instanceof EnrollError) return MESSAGES[err.code] ?? "Something went wrong — try again.";
  return "Something went wrong — try again.";
}

/** `#invite=ABCD-EFGH` (the broker's first-run link) -> the code; anything else -> null. */
export function inviteFromHash(hash: string): string | null {
  const m = /^#invite=([^&]+)$/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // malformed %-escape: not a code
  }
}

/** WebAuthn can't run on an IP host: on 127.0.0.1, the same page on `localhost`; otherwise null. */
export function localhostHint(loc: { hostname: string; port: string; pathname: string; hash: string }): string | null {
  if (loc.hostname !== "127.0.0.1") return null;
  const port = loc.port ? `:${loc.port}` : "";
  return `http://localhost${port}${loc.pathname}${loc.hash}`;
}

/**
 * The only thing on screen when nobody is signed in (modelled on
 * NewSessionScreen's full-screen `forced` state — not a modal). Two ways in:
 * sign in with an existing passkey, or redeem an invite to create one.
 */
export function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const invite = inviteFromHash(window.location.hash);
  const hint = localhostHint(window.location);
  const { control, handleSubmit } = useForm<InviteForm>({ defaultValues: { code: invite ?? "", name: "" } });
  const [showInvite, setShowInvite] = useState(invite !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await login();
      onAuthed();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const enroll = handleSubmit(async ({ code, name }) => {
    setBusy(true);
    setError(null);
    try {
      const options = await beginEnroll(code, name);
      await finishEnroll(code, options);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      onAuthed();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="login-screen">
      <div className="login-screen__card">
        <h1 className="login-screen__title">Welcome back</h1>
        <p className="login-screen__subtitle">Sign in with your passkey to reach your crew.</p>

        {hint ? (
          <p className="login-screen__hint" role="note">
            Passkeys don't work on an IP address. Open <a href={hint}>{hint}</a> instead.
          </p>
        ) : null}

        <Button variant="primary" onPress={signIn} isDisabled={busy}>
          Sign in
        </Button>

        {showInvite ? (
          <form className="login-screen__invite" onSubmit={enroll}>
            <FormTextField
              control={control}
              name="code"
              label="Invite code"
              placeholder="XXXX-XXXX"
              rules={{ required: true }}
            />
            <FormTextField
              control={control}
              name="name"
              label="Your name"
              placeholder="e.g. Edwin"
              rules={{ required: true }}
            />
            <Button type="submit" variant="secondary" isDisabled={busy}>
              Create passkey
            </Button>
          </form>
        ) : (
          <button type="button" className="login-screen__link" onClick={() => setShowInvite(true)}>
            I have an invite
          </button>
        )}

        {isCloud() ? null : (
          <p className="login-screen__firstrun">
            First time on this Mac? Open the sign-up link printed in the broker's terminal (
            <code>tmux attach -t smith-broker</code>). The link expires after 24 hours — restart the broker for a new
            one.
          </p>
        )}

        {error ? (
          <p className="login-screen__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
