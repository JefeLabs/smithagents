import { Avatar } from "../atoms/Avatar";
import { CLOUD_MODE } from "../lib/cloud";
import { useMe } from "../queries/http";

/**
 * The operator's own identity in the navbar — the one avatar in the app that is a
 * person rather than an agent. It renders nothing while cloud mode is off, which is
 * always, today: an all-local single-operator app has no account to show.
 *
 * Split in two on purpose. `useMe()` is an ungated `useQuery` (queries/http.ts), so a
 * single component would have to either call the hook below the flag guard — a
 * conditional hook call, which biome's `useHookAtTopLevel` rejects — or above it,
 * firing `GET /me` on every app load for an identity that cannot exist yet. Keeping
 * the hook at the top of a child that never mounts avoids both.
 */
export function OperatorAvatar() {
  if (!CLOUD_MODE) return null;
  return <SignedInAvatar />;
}

/**
 * Only ever mounted with cloud mode on. `MeRecord` carries no portrait, so the face is
 * the initial; the fallback name covers the first render before `/me` answers.
 *
 * Interactive (a real button) because an account avatar is a control, and that is the
 * shape OperatorAvatar.test.tsx asserts is absent. It has no press handler yet because
 * there is no account surface to open — whatever lands cloud mode wires that here.
 */
function SignedInAvatar() {
  const { data } = useMe();
  const name = data?.name ?? "Operator";
  return <Avatar initial={name[0]?.toUpperCase() ?? "?"} label={`${name} — account`} />;
}
