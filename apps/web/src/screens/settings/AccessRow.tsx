import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Lock, LockOpen } from "lucide-react";
import { ask, askText } from "../../Confirm";
import type { MenuItem } from "../../ContextMenu";
import { api, ApiError, type MachineProbe } from "../../api";
import { useCopied, useFlash } from "../../hooks";
import { queryKeys } from "../../queryKeys";
import { Button, ButtonLink, cx, ErrorNote, fieldClass, Spinner, Toggle } from "../../ui";
import { Block, Row } from "./Rows";

const WHY_LOCK =
  "ComfyUI has no login of its own: anything that reaches its address can run work on it, and ComfyUI-Manager installs whatever it is asked to. In 2026 a botnet took over ComfyUIs left open on the internet that way. Locked, every call needs this machine's token: Afflatus sends it, and your browser logs in once. It matters most for a ComfyUI other computers can reach (started with --listen, a rented instance, a forwarded port). The node pack keeps the lock; to take it off by hand, delete afflatus-lock.json from ComfyUI's user folder.";
const WHY_LOCAL =
  "Calls made on ComfyUI's own computer get in without the token, so your other tools there keep working while other computers stay locked out. A web page open in your browser still cannot use it. Leave it off when nothing else calls this ComfyUI.";
const CHECKS = ["Token made, kept in Afflatus", "ComfyUI locked", "Refused without the token", "Answering with it"];

/** An address over plain http on another machine (not this computer's loopback): a token sent to it is not encrypted. */
function plainAway(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return u.protocol === "http:" && !(host === "localhost" || host === "::1" || /^127\./.test(host));
  } catch {
    return false;
  }
}

/**
 * A change that loosens a lock (Unlock, "No token needed from this PC" on): the server holds it behind a sign-in of the last
 * 10 minutes (access.ts mayChange); without one, the password is asked and the call made again with it.
 */
async function withPassword<T>(run: (current?: string) => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ApiError && err.said.needPassword)) throw err;
  }
  const current = await askText({ title: "This change needs the password (no sign-in in the last 10 minutes)", value: "", placeholder: "Password", yes: "Confirm", password: true });
  if (!current) throw new Error("Not changed: it needs the password.");
  return run(current);
}

/**
 * A machine's token actions, for its card's menu and foot: copy the token (into the clipboard), renew it, unlock the
 * ComfyUI; each asked first where it cannot be undone. A lock set by the machine's environment (a pod's) has no renew or
 * unlock: it is the environment's.
 */
export function useAccessActions(id: string, label: string, probe: MachineProbe | undefined) {
  const client = useQueryClient();
  const { copied, copy } = useCopied();
  const told = () => {
    for (const queryKey of [queryKeys.machines(), queryKeys.settings(), queryKeys.queue(), queryKeys.setup()]) void client.invalidateQueries({ queryKey });
  };
  const copyToken = useMutation({ mutationFn: () => api.copyMachineToken(id), onSuccess: ({ token }) => copy(token) });
  const renew = useMutation({ mutationFn: (local: boolean) => api.lockMachine(id, { renew: true, local }), onSuccess: told });
  const unlock = useMutation({ mutationFn: () => withPassword((current) => api.unlockMachine(id, current)), onSuccess: told });
  const access = probe?.access;
  const locked = access?.state === "locked";
  const askRenew = () => void ask({ title: `Renew ${label}'s token?`, text: "What used the old one is refused from then on.", yes: "Renew" }).then((yes) => yes && renew.mutate(Boolean(access?.local)));
  const askUnlock = () => void ask({ title: `Unlock ${label}?`, text: "Anything that reaches it can use it again.", yes: "Unlock" }).then((yes) => yes && unlock.mutate());
  const items: MenuItem[] = [
    ...(probe?.tokenEnd ? [{ label: copied ? "Token copied" : "Copy its token", icon: <Copy size={14} />, run: () => copyToken.mutate() }] : []),
    ...(locked && !access.fixed ? [
      { label: "Renew the token…", icon: <KeyRound size={14} />, disabled: renew.isPending, note: renew.isPending ? "renewing…" : undefined, run: askRenew },
      { label: "Unlock…", icon: <LockOpen size={14} />, disabled: unlock.isPending, note: unlock.isPending ? "unlocking…" : undefined, run: askUnlock },
    ] : []),
  ];
  const failed = [copyToken, renew, unlock].find((m) => m.isError)?.error;
  return { items, copyToken: () => copyToken.mutate(), copied, renew: askRenew, unlock: askUnlock, busy: renew.isPending || unlock.isPending, failed };
}

/** A small pill: the lock's state at a glance, its icon and word in the state's colour. */
function Pill({ locked, children }: { locked: boolean; children: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border py-[3px] pl-2 pr-2.5 text-xs font-semibold", locked ? "border-good/35 bg-good/10 text-good" : "border-attention/40 bg-attention-wash text-attention-ink")}>
      {locked ? <Lock size={13} strokeWidth={2.2} /> : <LockOpen size={13} strokeWidth={2.2} />}
      {children}
    </span>
  );
}

/**
 * A machine's Access line (Settings › ComfyUI): locking it to Afflatus (the node pack's lock), a token to paste when it is
 * locked with another, and once locked only "No token needed from this PC" (the lock itself is said in the card's facts,
 * its token's actions are in the card's menu); under it, ComfyUI-Manager when it is too old. Nothing while it does not
 * answer and is not locked.
 */
export function AccessRow({ id, label, probe, url, rented = false, compact = false }: {
  id: string;
  label: string;
  probe: MachineProbe | undefined;
  url: string;
  /** A rented pod: its address is public, and its lock is set in its environment from its start. */
  rented?: boolean;
  /**
   * In a machine's card, whose facts say the lock and whose menu has the token's actions: locked, only the switch. The
   * one ComfyUI's Connection card has neither, and keeps the whole line (the lock, the token's end, Renew, Unlock).
   */
  compact?: boolean;
}) {
  const client = useQueryClient();
  const [checked, flashChecks] = useFlash(false, 2400);
  const [pasted, setPasted] = useState("");
  const told = () => {
    for (const queryKey of [queryKeys.machines(), queryKeys.settings(), queryKeys.queue(), queryKeys.setup()]) void client.invalidateQueries({ queryKey });
  };
  const lock = useMutation({ mutationFn: (o: { local?: boolean; renew?: boolean }) => (o.local ? withPassword((current) => api.lockMachine(id, { ...o, current })) : api.lockMachine(id, o)), onSuccess: (_, o) => { if (!o.renew && o.local === undefined) flashChecks(true); told(); } });
  const paste = useMutation({ mutationFn: (token: string) => api.machineToken(id, token), onSuccess: () => { setPasted(""); told(); } });
  const actions = useAccessActions(id, label, probe);
  const access = probe?.access;
  if (!access || access.state === "unknown") return null;
  const failed = [lock, paste].find((m) => m.isError)?.error ?? (compact ? undefined : actions.failed);
  const busy = lock.isPending || actions.busy;

  let line;
  if (checked || (lock.isPending && access.state === "open")) {
    // the checks, one under the other: what "locked" rests on
    line = (
      <span className="flex flex-col gap-1 py-1 text-body">
        {CHECKS.map((c) => <span key={c} className="flex items-center gap-1.5">{checked ? <Check size={13} className="text-good" /> : <Spinner size={13} />}{c}</span>)}
      </span>
    );
  } else if (access.state === "wrong") {
    line = (
      <>
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-xs font-semibold text-warn-ink">{probe.tokenEnd ? "Locked: the token Afflatus has is not its token" : "Locked by another Afflatus"}</span>
          <input aria-label={`${label}: its token`} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste its token…" spellCheck={false} autoComplete="off" className={cx("mt-1 h-9 max-w-[360px] font-mono text-xs", fieldClass)} />
        </span>
        <Button onClick={() => paste.mutate(pasted.trim())} disabled={pasted.trim().length < 16 || paste.isPending}>Use it</Button>
      </>
    );
  } else if (access.state === "locked" && !compact) {
    line = (
      <>
        <span className="flex min-w-0 grow flex-wrap items-center gap-2.5">
          <Pill locked>Locked</Pill>
          {access.fixed
            ? <span className="text-xs text-ink-2">{rented ? "from its first second: Afflatus set it in the pod's environment" : "by its start settings (AFFLATUS_TOKEN)"}</span>
            : probe.tokenEnd && <span className="font-mono text-meta text-ink-3" data-tip="The token's end: the token itself stays in Afflatus">token ••••••••{probe.tokenEnd}</span>}
          {probe.tokenEnd && <button type="button" className="text-xs font-semibold text-ink-2 hover:text-ink" onClick={actions.copyToken}>{actions.copied ? "Copied" : "Copy"}</button>}
        </span>
        {!access.fixed && (
          <span className="flex shrink-0 items-center gap-1">
            <Button size="sm" tone="quiet" onClick={actions.renew} disabled={busy}>Renew…</Button>
            <Button size="sm" tone="quiet" onClick={actions.unlock} disabled={busy}>Unlock…</Button>
          </span>
        )}
      </>
    );
  } else if (access.state === "locked") {
    line = null;
  } else {
    line = (
      <>
        <span className="flex min-w-0 grow flex-col gap-1">
          <Pill locked={false}>Not locked</Pill>
          <span className="text-xs text-ink-2">
            {access.off
              ? "Started with AFFLATUS_LOCK=off: start it without it to lock it."
              : rented && !access.canLock
                ? `${probe.pack ? `The Afflatus node pack on this pod is ${probe.pack}, too old to lock it` : "No Afflatus node pack on this pod"}: anything that finds its address can use it while it runs. Put the pack (0.13 or newer) on it, or use the Afflatus template, to have it locked.`
                : access.canLock
                ? "Anything that reaches this address can use this ComfyUI."
                : probe.pack ? `The Afflatus node pack 0.12 locks it; this one is ${probe.pack}: update it, then restart ComfyUI.` : "The Afflatus node pack locks it: install it, then restart ComfyUI."}
          </span>
        </span>
        {access.canLock && !access.off
          ? <Button tone="primary" onClick={() => lock.mutate({})} disabled={busy}>Lock it</Button>
          : !access.off && !rented && <ButtonLink href="/api/comfy/node-pack.zip" download size="sm">Download the pack</ButtonLink>}
      </>
    );
  }

  return (
    <>
      {line && <Row setting="comfy.access" label="Access" help={WHY_LOCK} start={checked}>{line}</Row>}
      {/* locked: its one setting, as a switch (a lock set by the environment, a pod's, has none) */}
      {access.state === "locked" && !checked && !access.fixed && (
          <Row setting="comfy.access" label="No token needed from this PC" help={`${WHY_LOCAL} ${WHY_LOCK}`}>
            <Toggle bare on={access.local} disabled={busy} onChange={(local) => lock.mutate({ local })} label="No token needed from this PC" />
          </Row>
        )}
      {access.state === "locked" && plainAway(url) && (
        <Block><span className="text-xs text-ink-2">Reached over plain http: the token crosses the network between here and it as it is. Fine on your own network; anywhere else, reach it over https or through a tunnel (Tailscale, SSH).</span></Block>
      )}
      {access.managerOld && (
        <Row label="ComfyUI-Manager" tone="warn" help="ComfyUI-Manager before 3.38 let anyone who reached it install a node pack: the way the 2026 botnet got in. Locked, nobody else can reach it anyway; update it all the same.">
          <span className="text-xs text-warn-ink">{access.manager} is too old: update it from ComfyUI's Manager, to 3.38 or later.</span>
        </Row>
      )}
      {failed && <Block><ErrorNote>{failed.message}</ErrorNote></Block>}
    </>
  );
}
