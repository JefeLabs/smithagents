import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/cloud", () => ({ CLOUD_MODE: true }));
vi.mock("../api/auth", () => ({
  getMe: vi.fn(),
  login: vi.fn(),
  beginEnroll: vi.fn(),
  finishEnroll: vi.fn(),
  EnrollError: class extends Error {},
}));

import { getMe } from "../api/auth";
import { useAuthStore } from "../stores/authStore";
import { AuthGate } from "./AuthGate";

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSessionLost();
});

describe("AuthGate (cloud mode)", () => {
  it("renders children when /auth/me is a human", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "human", name: "edwin" });
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
  });

  it("renders the login screen when unauthenticated", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument());
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
  });

  it("drops to login when sessionLost flips, even after a good /auth/me", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "human", name: "edwin" });
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
    useAuthStore.getState().markSessionLost();
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument());
  });
});
