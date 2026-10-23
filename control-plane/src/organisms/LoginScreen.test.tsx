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
import { inviteFromHash, LoginScreen, localhostHint } from "./LoginScreen";

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("first-run link helpers", () => {
  it("inviteFromHash reads the first-run link", () => {
    expect(inviteFromHash("#invite=ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(inviteFromHash("")).toBeNull();
    expect(inviteFromHash("#other=1")).toBeNull();
  });
  it("localhostHint: on 127.0.0.1 it points at localhost, keeping port, path and hash", () => {
    expect(localhostHint({ hostname: "127.0.0.1", port: "1420", pathname: "/", hash: "#invite=X" })).toBe(
      "http://localhost:1420/#invite=X",
    );
    expect(localhostHint({ hostname: "localhost", port: "1420", pathname: "/", hash: "" })).toBeNull();
  });
});

describe("LoginScreen", () => {
  it("a first-run link opens the invite form with the code filled in", () => {
    window.location.hash = "#invite=ABCD-EFGH";
    render(<LoginScreen onAuthed={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /invite code/i })).toHaveValue("ABCD-EFGH");
  });

  it("tells a first-time user where the sign-up link is", () => {
    render(<LoginScreen onAuthed={vi.fn()} />);
    expect(screen.getByText(/tmux attach -t smith-broker/)).toBeInTheDocument();
  });

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
