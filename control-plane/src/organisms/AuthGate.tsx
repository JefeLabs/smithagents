import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getMe } from "../api/auth";
import { useAuthStore } from "../stores/authStore";
import { LoginScreen } from "./LoginScreen";

/**
 * One gate for every mode. It holds the app behind /auth/me: a splash while the
 * check is in flight, the login screen when unauthenticated OR after a
 * mid-session drop (brokerFetch 401 / WS 4401 both flip `sessionLost`), and the
 * app once a human is present. An open-mode broker answers /auth/me with
 * `{kind:"human", local:true}`, so it passes straight through. Mounted above
 * the router so it precedes the socket connect HomePage owns.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const sessionLost = useAuthStore((s) => s.sessionLost);
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });

  if (isLoading) {
    return <div className="auth-gate__splash" aria-busy="true" />;
  }

  if (sessionLost || !me) {
    return (
      <LoginScreen
        onAuthed={() => {
          useAuthStore.getState().clearSessionLost();
          void qc.invalidateQueries({ queryKey: ["me"] });
        }}
      />
    );
  }

  return <>{children}</>;
}
