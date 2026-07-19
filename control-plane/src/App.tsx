import { useState } from "react";

/**
 * Control-plane shell (PRD §5).
 *
 * This is the single React codebase compiled into both the desktop (laptop) and
 * iOS (WKWebView) Tauri wrappers. For now it renders a placeholder dashboard and
 * a stubbed connection indicator to the Spring Boot gateway. Real wiring —
 * mTLS-over-ngrok WebSocket, multiplexed terminal streams, push-to-talk, the
 * Audio Forge — lands in later slices.
 */
type GatewayStatus = "disconnected" | "connecting" | "connected";

export function App() {
  const [status] = useState<GatewayStatus>("disconnected");

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: "2rem",
        minHeight: "100vh",
        background: "#0b0d10",
        color: "#e6e6e6",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "1.25rem" }}>smithagents · control plane</h1>
      <p style={{ opacity: 0.6, marginTop: "0.25rem" }}>
        gateway: <strong data-status={status}>{status}</strong>
      </p>
      <hr style={{ borderColor: "#1c2128", margin: "1.5rem 0" }} />
      <p style={{ opacity: 0.5 }}>
        Skeleton. Terminal multiplexer, Audio Forge, and push-to-talk arrive in
        the Tauri control-plane slice.
      </p>
    </main>
  );
}
