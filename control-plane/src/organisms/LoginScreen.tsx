import { Button } from "@heroui/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { beginEnroll, EnrollError, finishEnroll, login } from "../api/auth";
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

/**
 * The only thing on screen when a cloud tenant isn't signed in (modelled on
 * NewSessionScreen's full-screen `forced` state — not a modal). Two ways in:
 * sign in with an existing passkey, or redeem an invite to create one.
 */
export function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const { control, handleSubmit } = useForm<InviteForm>({ defaultValues: { code: "", name: "" } });
  const [showInvite, setShowInvite] = useState(false);
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

        <Button variant="primary" onPress={signIn} isDisabled={busy}>
          Sign in
        </Button>

        {showInvite ? (
          <form className="login-screen__invite" onSubmit={enroll}>
            <FormTextField control={control} name="code" label="Invite code" placeholder="XXXX-XXXX" rules={{ required: true }} />
            <FormTextField control={control} name="name" label="Your name" placeholder="e.g. Edwin" rules={{ required: true }} />
            <Button type="submit" variant="secondary" isDisabled={busy}>
              Create passkey
            </Button>
          </form>
        ) : (
          <button type="button" className="login-screen__link" onClick={() => setShowInvite(true)}>
            I have an invite
          </button>
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
