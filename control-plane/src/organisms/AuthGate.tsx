import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getMe } from "../api/auth";
import { qk } from "../queries/keys";
import { useAuthStore } from "../stores/authStore";
import { LoginScreen } from "./LoginScreen";

/**
 * One gate for every mode. It holds the app behind /auth/me: a splash while the
 * check is in flight, the login screen when unauthenticated OR after a
 * mid-session drop (brokerFetch 401 / WS 4401 both flip `sessionLost`), and the
 * app once a human is present. An unreachable broker is NOT "signed out": it
 * shows "can't reach" and keeps retrying, never a login that cannot succeed. An open-mode broker answers /auth/me with
 * `{kind:"human", local:true}`, so it passes straight through. Mounted above
 * the router so it precedes the socket connect HomePage owns.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const sessionLost = useAuthStore((s) => s.sessionLost);
  // getMe returns null on a 401 and throws only when the broker is unreachable, so
  // retrying forever is safe: it never retries an auth answer.
  const {
    data: me,
    isLoading,
    isError,
    failureCount,
    refetch,
  } = useQuery({ queryKey: qk.authMe, queryFn: getMe, retry: true, retryDelay: 2000 });

  // Only before the first answer: a background refetch that fails while the
  // identity is already loaded must never unmount the app.
  if (!me && (isError || failureCount > 0)) {
    return (
      <div className="auth-gate__splash" role="alert">
        <p>Can't reach the broker — retrying…</p>
        <button type="button" onClick={() => void refetch()}>
          Retry now
        </button>
      </div>
    );
  }

  if (isLoading) {
    return <div className="auth-gate__splash" aria-busy="true" />;
  }

  if (sessionLost || !me) {
    return (
      <LoginScreen
        onAuthed={() => {
          useAuthStore.getState().clearSessionLost();
          void qc.invalidateQueries({ queryKey: qk.authMe });
        }}
      />
    );
  }

  return <>{children}</>;
}
