import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/auth", async () => {
  class EnrollError extends Error {
    constructor(public code: string) {
      super(code);
    }
  }
  return {
    login: vi.fn(),
    beginEnroll: vi.fn(),
    finishEnroll: vi.fn(),
    EnrollError,
  };
});

import { beginEnroll, EnrollError, finishEnroll, login } from "../api/auth";
import { LoginScreen } from "./LoginScreen";

afterEach(() => vi.restoreAllMocks());

describe("LoginScreen", () => {
  it("Sign in runs login() then onAuthed", async () => {
    (login as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: "u1", name: "edwin" });
    const onAuthed = vi.fn();
    render(<LoginScreen onAuthed={onAuthed} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(onAuthed).toHaveBeenCalled());
  });

  it("a bad invite shows the invalid-or-expired message and does not call onAuthed", async () => {
    (beginEnroll as ReturnType<typeof vi.fn>).mockRejectedValue(new EnrollError("bad-code" as never));
    const onAuthed = vi.fn();
    render(<LoginScreen onAuthed={onAuthed} />);
    await userEvent.click(screen.getByRole("button", { name: /i have an invite/i }));
    await userEvent.type(screen.getByPlaceholderText("XXXX-XXXX"), "WRONG-CODE");
    await userEvent.type(screen.getByPlaceholderText(/edwin/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /create passkey/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/invalid or expired/i));
    expect(onAuthed).not.toHaveBeenCalled();
  });

  it("a good invite enrolls and calls onAuthed", async () => {
    (beginEnroll as ReturnType<typeof vi.fn>).mockResolvedValue({ challenge: "c" });
    (finishEnroll as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: "u1", name: "edwin" });
    const onAuthed = vi.fn();
    render(<LoginScreen onAuthed={onAuthed} />);
    await userEvent.click(screen.getByRole("button", { name: /i have an invite/i }));
    await userEvent.type(screen.getByPlaceholderText("XXXX-XXXX"), "GOOD-CODE");
    await userEvent.type(screen.getByPlaceholderText(/edwin/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /create passkey/i }));
    await waitFor(() => expect(onAuthed).toHaveBeenCalled());
  });
});
