import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { cx } from "../ui";
import { SignIn } from "./SignIn";
import { useSignedOut } from "./signedOut";

/**
 * The app's root behind the password (access.ts). The page asks GET /api/session first: locked and not signed in, the
 * sign-in page is all there is, and the app is not drawn (nothing of it is fetched). Signed in later, the app fades in.
 * A session that ends while the app is open (the lock's 401, signedOut.ts) brings the sign-in back over the app, which
 * stays as it was underneath, unsaved work and all; signed in again, everything is read again.
 */
export function Gate({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.session(), queryFn: () => api.session(), staleTime: Infinity, retry: 2 });
  const out = useSignedOut((s) => s.out);
  const [entered, setEntered] = useState(false);
  // Whether the app was drawn once: from then on a session that ends brings the sign-in over it, never in its place, or
  // the open editors, dialogs and a draft's edit not yet saved would go with it.
  const drawn = useRef(false);
  // the 401 said this browser is out: what the sign-in needs (the days, whether Telegram is a way) read again
  const { refetch } = session;
  useEffect(() => {
    if (out) void refetch();
  }, [out, refetch]);

  // nothing until the answer: neither the app (its data would be asked for) nor the sign-in (it may not be needed)
  if (session.isPending) return <div className="h-full bg-ground" />;
  const state = session.data;
  // a server that does not answer: the app, which says so in its own way (and a 401 later brings the sign-in)
  if (state && state.locked && !state.signedIn && !entered && !drawn.current) {
    return (
      <SignIn
        state={state}
        onIn={() => {
          client.setQueryData(queryKeys.session(), { ...state, signedIn: true, session: true });
          useSignedOut.getState().set(false);
          setEntered(true);
        }}
      />
    );
  }
  drawn.current = true;
  return (
    <>
      <div className={cx("h-full", entered && "m-gate-in")}>{children}</div>
      {out && state && (
        <SignIn
          state={state}
          onIn={() => {
            useSignedOut.getState().set(false);
            setEntered(true);
            // what failed while signed out, and everything else, read again
            void client.invalidateQueries();
          }}
        />
      )}
    </>
  );
}
