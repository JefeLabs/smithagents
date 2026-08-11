import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getMe } from "../api/auth";
import { CLOUD_MODE } from "../lib/cloud";
import { useAuthStore } from "../stores/authStore";
import { LoginScreen } from "./LoginScreen";

/**
 * In local/tauri mode this is a passthrough — no query, no gate, today's UX
 * unchanged. In cloud mode it holds the app behind /auth/me: a splash while the
 * check is in flight, the login screen when unauthenticated OR after a
 * mid-session drop (brokerFetch 401 / WS 4401 both flip `sessionLost`), and the
 * app once a human is present. Mounted above the router so it precedes the
 * socket connect HomePage owns — an unauthenticated socket now gets 4401'd.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  if (!CLOUD_MODE) return <>{children}</>;
  return <CloudAuthGate>{children}</CloudAuthGate>;
}

function CloudAuthGate({ children }: { children: ReactNode }) {
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
