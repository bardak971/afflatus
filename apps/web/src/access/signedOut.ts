import { create } from "zustand";

/**
 * Whether the server said this browser is no longer signed in (the lock's 401, api.ts): its session ended while the app
 * was open (12 h idle, signed out from another device, the password changed). The gate (Gate.tsx) then shows the sign-in
 * over the app, which stays as it was underneath, and takes this back once signed in again.
 */
export const useSignedOut = create<{ out: boolean; set(out: boolean): void }>((set) => ({ out: false, set: (out) => set({ out }) }));

export const signedOut = () => {
  if (!useSignedOut.getState().out) useSignedOut.getState().set(true);
};
