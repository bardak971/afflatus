import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Send, SquareTerminal } from "lucide-react";
import { api, ApiError, type SessionState } from "../api";
import { Mark } from "../NavRail";
import { clock, plural } from "../format";
import { useNow } from "../hooks";
import { motionAllowed } from "../useFlip";
import { Button, Checkbox, cx, fieldClass } from "../ui";
import { codeOf, codeShown } from "./codeInput";

/**
 * The sign-in page of an Afflatus with a password (access.ts): the password, Forgot password? (a code to Telegram or to
 * this computer's console), the code and a new password, and Password changed. A wrong try shakes the card and says the
 * tries left; signed in, the button turns to the good colour, the mark pulses, the card lifts away and the app fades in
 * (with motion reduced: only the states, no movement).
 */

type Screen = "signin" | "forgot" | "code" | "done";
type Via = "telegram" | "computer";

/** The words of a refusal: the tries left, or the wait, or the server's own words. */
function refusalSaid(err: unknown, what: string): string {
  if (!(err instanceof ApiError)) return (err as Error).message;
  if (err.status === 403 && err.said.left !== undefined) {
    if (err.said.left > 0) return `${err.message} · ${plural(err.said.left, "try", "tries")} left, then a wait`;
    if (err.said.wait) return `${err.message} · wait before the next try`;
  }
  if (err.status === 429 && err.said.wait) return `${what}: wait before the next try.`;
  return err.message;
}

const WAYS: Array<{ via: Via; title: string; note: string; icon: ReactNode }> = [
  { via: "telegram", title: "Telegram", note: "To your bot's chat, set in Settings › Interface › Notifications.", icon: <Send size={15} /> },
  { via: "computer", title: "This computer", note: "Written to Afflatus's console and its log file (data/logs/afflatus.log; docker logs on Docker). Always there.", icon: <SquareTerminal size={15} /> },
];

/** A link-like button of the card: Forgot password?, Another way. */
function TextButton({ onClick, quiet, children }: { onClick(): void; quiet?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("p-0 text-body hover:underline", quiet ? "text-ink-2" : "text-accent")}>
      {children}
    </button>
  );
}

export function SignIn({ state, onIn }: { state: SessionState; onIn(): void }) {
  const [screen, setScreen] = useState<Screen>("signin");
  const [entering, setEntering] = useState(false);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [said, setSaid] = useState<string | null>(null);
  // each wrong try plays the shake again: two class names in turn (styles.css)
  const [shakes, setShakes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState(() => (state.wait ? Date.now() + state.wait * 1000 : 0));
  const [via, setVia] = useState<Via>("computer");
  const [sendUntil, setSendUntil] = useState(0);
  const [code, setCode] = useState("");
  const [fresh, setFresh] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const field = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const now = useNow(1000, waitUntil > Date.now() || sendUntil > Date.now());
  const waitLeft = Math.max(0, waitUntil - now);
  const sendLeft = Math.max(0, Math.ceil((sendUntil - now) / 1000));
  const ways = WAYS.filter((w) => w.via === "computer" || state.telegram);

  useEffect(() => {
    if (screen === "code") codeField.current?.focus();
  }, [screen]);

  const go = (next: Screen) => {
    setSaid(null);
    setScreen(next);
  };

  /** Signed in: the good state, then the app (the card lifts away meanwhile; with motion reduced, a short beat of the state alone). */
  const enter = () => {
    setEntering(true);
    window.setTimeout(onIn, motionAllowed() ? 760 : 350);
  };

  /** A refusal: said under the field, the card shaken, the wait counted down; the field keeps the focus, its text selected. */
  const refused = (err: unknown, what: string, focus: HTMLInputElement | null | undefined) => {
    if (err instanceof ApiError && err.said.wait) setWaitUntil(Date.now() + err.said.wait * 1000);
    if (err instanceof ApiError && (err.status === 403 || err.status === 429)) setShakes((n) => n + 1);
    setSaid(refusalSaid(err, what));
    window.requestAnimationFrame(() => {
      focus?.focus();
      focus?.select();
    });
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || waitLeft || !password) return;
    setBusy(true);
    try {
      await api.signIn(password, remember);
      setSaid(null);
      enter();
    } catch (err) {
      refused(err, "Too many wrong tries", field.current);
    } finally {
      setBusy(false);
    }
  };

  const send = async (how: Via) => {
    if (busy) return;
    setBusy(true);
    try {
      const sent = await api.forgotCode(how);
      setVia(how);
      setSendUntil(Date.now() + sent.again * 1000);
      setCode("");
      go("code");
    } catch (err) {
      refused(err, "Too many tries", null);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const typed = codeOf(code);
    if (!typed) return setSaid("Enter the 10 characters of the code.");
    if (fresh.length < 8) return setSaid("A password is 8 characters at least.");
    setBusy(true);
    try {
      await api.resetWithCode(typed, fresh, signOutOthers);
      go("done");
    } catch (err) {
      refused(err, "Too many wrong codes", codeField.current);
      // a code used up or expired is emptied: a new one is asked for
      if (err instanceof ApiError && (err.status === 400 || (err.status === 403 && !err.said.left))) setCode("");
    } finally {
      setBusy(false);
    }
  };

  const wrong = said !== null && screen === "signin";
  const sentSaid = via === "telegram" ? "Sent to your Telegram bot's chat." : "Written to Afflatus's console and to data/logs/afflatus.log on the computer it runs on.";
  return (
    <div className="fixed inset-0 z-tip flex flex-col items-center justify-center gap-[22px] overflow-y-auto bg-ground px-4 py-8">
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(600px 420px at 50% 38%, color-mix(in srgb, var(--color-accent) 7%, transparent), transparent 70%)" }} />
      <div className={cx("relative flex flex-col items-center gap-3", entering && "m-gate-lift")}>
        <span className={cx("block rounded-card", entering && "m-gate-pulse")}><Mark big /></span>
        <span className="text-xl font-bold">Afflatus</span>
      </div>

      <div
        className={cx(
          "relative flex w-[400px] max-w-full flex-col gap-4 rounded-2xl border border-line bg-panel p-[26px] shadow-[0_24px_60px_color-mix(in_srgb,var(--color-shade)_45%,transparent)]",
          entering ? "m-gate-lift" : shakes ? (shakes % 2 ? "m-gate-shake-a" : "m-gate-shake-b") : "",
        )}
      >
        {screen === "signin" && (
          <form onSubmit={(e) => void signIn(e)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-base font-bold">Sign in</h1>
              <span className="text-body text-ink-2">This Afflatus has a password.</span>
            </div>
            <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
              Password
              <input
                ref={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password"
                aria-invalid={wrong} disabled={entering}
                className={cx("h-10 text-title tracking-label transition-[border-color,box-shadow] aria-[invalid=true]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warn)_16%,transparent)]", fieldClass)}
              />
            </label>
            {said && <span role="alert" key={shakes} className="m-gate-said -mt-2 text-body text-warn-ink">{said}</span>}
            <Checkbox checked={remember} onChange={setRemember} className="text-body">Remember this device for {plural(state.stayDays, "day")}</Checkbox>
            <Button type="submit" tone="primary" disabled={busy || waitLeft > 0 || entering || !password} className={cx("h-[42px] text-title", entering && "bg-good! text-ground! disabled:opacity-100!")}>
              {entering && <Check size={16} strokeWidth={3} />}
              {entering ? "Signed in" : waitLeft ? `Wait ${clock(waitLeft)}` : "Sign in"}
            </Button>
            <div className="flex items-center justify-between">
              <TextButton onClick={() => go("forgot")}>Forgot password?</TextButton>
            </div>
          </form>
        )}

        {screen === "forgot" && (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1">
              <h1 className="text-base font-bold">Get a code to reset it</h1>
              <span className="text-body text-ink-2">A 10-character code, valid 10 minutes in this browser, sent where only you can read it.</span>
            </div>
            {ways.map((w) => (
              <button
                key={w.via} type="button" disabled={busy} onClick={() => void send(w.via)}
                className="flex items-start gap-3 rounded-control border border-line bg-raised px-3.5 py-3 text-left hover:bg-hover disabled:opacity-60"
              >
                <span className={cx("grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg", w.via === "telegram" ? "bg-picture text-ground" : "bg-ink-3 text-ground")}>{w.icon}</span>
                <span className="flex grow flex-col gap-[3px]">
                  <span className="text-title font-semibold">{w.title}</span>
                  <span className="text-xs leading-[1.45] text-ink-2">{w.note}</span>
                </span>
              </button>
            ))}
            {state.telegramHeld > 0 && <span className="text-xs text-ink-3">Telegram's bot or chat changed lately: codes go there again in {state.telegramHeld >= 60 ? `${Math.ceil(state.telegramHeld / 60)} h` : `${state.telegramHeld} min`}.</span>}
            {said && <span role="alert" className="m-gate-said text-body text-warn-ink">{said}</span>}
            <span><TextButton quiet onClick={() => go("signin")}>I remember it now</TextButton></span>
          </div>
        )}

        {screen === "code" && (
          <form onSubmit={(e) => void reset(e)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-base font-bold">Enter the code</h1>
              <span className="text-body leading-[1.45] text-ink-2">{sentSaid} 10 characters, valid 10 minutes, once, in this browser.</span>
            </div>
            <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
              Code
              <input
                ref={codeField} value={code} onChange={(e) => setCode(codeShown(e.target.value))} autoComplete="one-time-code" spellCheck={false} autoCapitalize="characters"
                placeholder="K7M2P-9XQ4R" aria-invalid={said !== null}
                className={cx("h-12 text-center font-mono text-xl tracking-[0.18em] placeholder:text-ink-3/50", fieldClass)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
              New password
              <input type="password" value={fresh} onChange={(e) => setFresh(e.target.value)} autoComplete="new-password" className={cx("h-10 text-title tracking-label", fieldClass)} />
            </label>
            <Checkbox checked={signOutOthers} onChange={setSignOutOthers} className="text-body">Sign out every other device</Checkbox>
            {said && <span role="alert" key={shakes} className="m-gate-said -mt-1 text-body text-warn-ink">{said}</span>}
            <Button type="submit" tone="primary" disabled={busy || waitLeft > 0} className="h-[42px] text-title">{waitLeft ? `Wait ${clock(waitLeft)}` : "Set the new password"}</Button>
            <div className="flex items-center justify-between text-body">
              <TextButton quiet onClick={() => go("forgot")}>Another way</TextButton>
              {sendLeft ? <span className="text-ink-3">Send again in {sendLeft} s</span> : <TextButton onClick={() => void send(via)}>Send again</TextButton>}
            </div>
          </form>
        )}

        {screen === "done" && (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-good/15 text-good"><Check size={20} strokeWidth={2.5} /></span>
            <h1 className="text-base font-bold">Password changed</h1>
            <span className="text-body leading-[1.45] text-ink-2">
              You are signed in here.{" "}
              {signOutOthers && state.telegram ? "Every other device was signed out, and Telegram was told." : signOutOthers ? "Every other device was signed out." : state.telegram ? "Telegram was told." : ""}
            </span>
            <Button tone="primary" autoFocus disabled={entering} onClick={enter} className="h-[42px] w-full text-title">Open Afflatus</Button>
          </div>
        )}
      </div>

      <span className="relative font-mono text-meta text-ink-3">Afflatus {__AFFLATUS_VERSION__}</span>
    </div>
  );
}
