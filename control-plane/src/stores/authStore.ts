/**
 * The non-React → React channel for "the session is gone". `brokerFetch`
 * (a plain async function) flips `sessionLost` on a cloud 401, and the socket
 * store flips it on a 4401 upgrade close; `AuthGate` reads it to drop the user
 * back to the login screen without a reload. Kept tiny and separate from the
 * socket store so a fetch-triggered logout doesn't have to reach into it.
 */
import { create } from "zustand";

interface AuthState {
  sessionLost: boolean;
  markSessionLost: () => void;
  clearSessionLost: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  sessionLost: false,
  markSessionLost: () => set({ sessionLost: true }),
  clearSessionLost: () => set({ sessionLost: false }),
}));
