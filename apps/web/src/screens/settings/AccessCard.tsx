import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Monitor, Smartphone, Tablet } from "lucide-react";
import { api, ApiError, type AccessSettings, type SignedDevice, type SignedDevices } from "../../api";
import { useSettings } from "../../data";
import { dayMonth, plural, when } from "../../format";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Select } from "../../Select";
import { useCopied } from "../../hooks";
import { Button, Checkbox, Chip, cx, ErrorNote, fieldClass, Toggle, TwoStep } from "../../ui";
import { PasswordAsk } from "./PasswordAsk";
import { Block, Card, Row } from "./Rows";

/**
 * Settings › Interface › Access: the optional password (access.ts). Where Afflatus listens, the password itself (set,
 * change, turn off: each asks for the current one), whether this computer needs it, how long a device stays signed in,
 * where reset codes go, and the devices signed in now.
 */

const HELP = "A password for Afflatus. Set, every page, API call and /metrics needs a signed-in device (the probe's /api/health, the sign-in itself and a download ComfyUI fetches excepted; Prometheus uses the metrics token). Too many wrong tries make everyone wait a minute: devices signed in go on, and you are told on Telegram and here. Forgot it: Forgot password? on the sign-in sends a 10-character code (K7M2P-9XQ4R) to Telegram or to this computer's console and data/logs/afflatus.log. Lost every way in: stop Afflatus and run Afflatus.bat reset-password (./afflatus.sh reset-password; from the sources pnpm start reset-password; Docker: docker compose run --rm afflatus node apps/server/dist/index.mjs reset-password), or start it once with AFFLATUS_RESET_PASSWORD=1. Either removes the password and signs every device out.";
const LOCAL_HELP = "On: a request from the computer Afflatus runs on (a loopback address, asked as localhost, carrying no proxy header) gets in without the password. Off by default. Offered only while Afflatus listens on the network (HOST=0.0.0.0): listening on this computer only, anyone reaching it from elsewhere comes through something on this computer that forwards connections (a port proxy, ssh -R, WSL, a reverse proxy), which looks like this computer. Even on the network, any such forwarder or a reverse proxy on this computer makes every visitor look local. In Docker the host's requests come through Docker's network: nothing is exempt there.";
const LOCAL_OFF_HELP = "Not offered: Afflatus listens on this computer only (HOST=127.0.0.1), so anyone who reaches it from elsewhere comes through something on this computer that forwards connections, which looks like this computer. The exemption would let exactly them in.";
const METRICS_HELP = "While a password is set, /metrics needs a session or this token, sent by Prometheus as a Bearer token (authorization: credentials). Shown once when made: copy it then. Make a new one to replace it.";
const STAY_HELP = "How long a device stays signed in when \"Remember this device\" was ticked at its sign-in. Not ticked: until the browser closes, or 12 h without use. A change counts from the next sign-in.";
const CODES_HELP = "Where Forgot password? may send a 10-character code (valid 10 minutes, once, only in the browser that asked for it). A Telegram bot or chat changed lately gets none for 24 h. This computer always: Afflatus's console and data/logs/afflatus.log (docker logs on Docker), which only someone at the machine reads. Telegram: your bot's chat, once Telegram is set in Notifications; in a group chat every member sees the code.";
const NEW_HELP = "A notice on Telegram when a device never seen before signs in: its browser and address. Changing this, From this computer or where codes go asks for the password unless you signed in within 10 minutes.";

const STAY: Array<{ value: string; label: string }> = [1, 7, 30, 90].map((d) => ({ value: String(d), label: plural(d, "day") }));

/** What the card changes on the server: an Access setting, or the metrics token made (true) or taken off (false). */
type AccessPatch = { localNoPassword?: boolean; stayDays?: AccessSettings["stayDays"]; resetTelegram?: boolean; newDevice?: { telegram?: boolean } } | { metrics: boolean };

/** A device's icon from its name ("Safari on iPhone"). */
function DeviceIcon({ name }: { name: string }) {
  const Icon = /iPhone|Android/.test(name) ? Smartphone : /iPad/.test(name) ? Tablet : Monitor;
  return <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-raised text-ink-2"><Icon size={15} /></span>;
}

/** Where Afflatus listens, said as who can reach it. */
function reachSaid(listen: SignedDevices["listen"]): string {
  if (listen.reach === "computer") return "this computer only";
  if (listen.reach === "network") return "this computer and your network";
  return "this address";
}

/** The password set, changed or turned off: the form under the Password row, open for one of the three. */
function PasswordForm({ mode, done, cancel }: { mode: "set" | "change" | "off"; done(): void; cancel(): void }) {
  const [current, setCurrent] = useState("");
  const [fresh, setFresh] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [said, setSaid] = useState<string | null>(null);
  const go = useMutation({
    mutationFn: () => (mode === "off" ? api.passwordOff(current) : api.setPassword(fresh, current, mode === "change" && signOutOthers)),
    onSuccess: done,
    onError: (err) => {
      const left = err instanceof ApiError ? err.said.left : undefined;
      setSaid(left ? `${err.message} · ${plural(left, "try", "tries")} left, then a wait` : err.message);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode !== "off" && fresh.length < 8) return setSaid("A password is 8 characters at least.");
    setSaid(null);
    go.mutate();
  };
  const box = cx("h-9 w-56 text-body", fieldClass);
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      {mode !== "set" && (
        <label className="flex items-center justify-between gap-3 text-body">
          Current password
          <input type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={box} />
        </label>
      )}
      {mode !== "off" && (
        <label className="flex items-center justify-between gap-3 text-body">
          {mode === "set" ? "Password" : "New password"}
          <input type="password" autoFocus={mode === "set"} autoComplete="new-password" placeholder="8 characters at least" value={fresh} onChange={(e) => setFresh(e.target.value)} className={box} />
        </label>
      )}
      {mode === "change" && <Checkbox checked={signOutOthers} onChange={setSignOutOthers} className="self-end text-body">Sign out every other device</Checkbox>}
      {said && <ErrorNote>{said}</ErrorNote>}
      <span className="flex justify-end gap-2">
        <Button size="sm" tone="quiet" onClick={cancel}>Cancel</Button>
        <Button size="sm" type="submit" tone={mode === "off" ? "danger" : "primary"} disabled={go.isPending}>
          {mode === "set" ? "Set the password" : mode === "change" ? "Change it" : "Turn the password off"}
        </Button>
      </span>
    </form>
  );
}

/** One device signed in: its browser, when it was first seen, its address, when it was last seen, and Sign out. */
function DeviceRow({ d, onOut, busy }: { d: SignedDevice; onOut(): void; busy: boolean }) {
  return (
    <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 px-gutter py-2 sm:grid-cols-[30px_minmax(0,1fr)_150px_110px_auto]">
      <DeviceIcon name={d.name} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-body font-semibold">{d.name} {d.here && <span className="text-meta text-good">this device</span>}</span>
        <span className="text-meta text-ink-3">first seen {dayMonth(d.firstSeen)}</span>
      </span>
      <span className="hidden truncate font-mono text-xs text-ink-2 sm:block">{d.ip}</span>
      <span className="hidden text-xs text-ink-2 sm:block">{when(d.lastSeen)}</span>
      <Button size="sm" disabled={busy} onClick={onOut} aria-label={`Sign out ${d.name}${d.here ? " (this device)" : ""}`}>Sign out</Button>
    </div>
  );
}

export function AccessCard() {
  const client = useQueryClient();
  const settings = useSettings().data;
  const a: AccessSettings | undefined = settings?.access;
  const devices = useQuery({ queryKey: queryKeys.signedDevices(), queryFn: () => api.signedDevices() });
  const session = useQuery({ queryKey: queryKeys.session(), queryFn: () => api.session(), staleTime: Infinity });
  const [form, setForm] = useState<"set" | "change" | "off" | null>(null);
  const sayFailed = useSayFailed({ href: "/settings/interface", go: "Open Settings › Interface" });
  const readAgain = () => {
    void client.invalidateQueries({ queryKey: queryKeys.settings() });
    void client.invalidateQueries({ queryKey: queryKeys.session() });
  };
  // a change the server asks the password for (a sign-in older than 10 minutes): held while the password is typed
  const [asking, setAsking] = useState<{ patch: AccessPatch; said: string | null } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const { copied, copy } = useCopied();
  const save = useMutation({
    mutationFn: ({ patch, password }: { patch: AccessPatch; password?: string }) =>
      "metrics" in patch ? api.metricsToken(patch.metrics, password).then((r) => setToken(r.token)) : api.accessSettings(patch, password).then(() => undefined),
    onSuccess: () => {
      setAsking(null);
      readAgain();
      void client.invalidateQueries({ queryKey: queryKeys.signedDevices() });
    },
    onError: (err, { patch }) => {
      if (err instanceof ApiError && (err.said.needPassword || (asking && err.status === 403))) setAsking({ patch, said: asking ? err.message : null });
      else if (err instanceof ApiError && err.status === 429) setAsking({ patch, said: err.message });
      else sayFailed("The access settings were not saved")(err);
    },
  });
  const change = (patch: AccessPatch) => save.mutate({ patch });
  // this device signed out (from its row, or everywhere): the page starts again, on the sign-in, with nothing of the app kept
  const out = useMutation({
    mutationFn: (d: SignedDevice | "everywhere") => (d === "everywhere" ? api.signOutEverywhere(false) : api.signOutDevice(d.id)).then(() => d),
    onSuccess: (d) => {
      if ((d === "everywhere" && session.data?.session) || (d !== "everywhere" && d.here)) location.reload();
      else readAgain();
    },
    onError: sayFailed("Not signed out"),
  });
  if (!a || !settings) return null;
  const listen = devices.data?.listen;
  const where = listen ? `${listen.host}:${listen.port}` : "";
  const telegramSet = settings.notify.hasTelegramToken && Boolean(settings.notify.telegramChat);
  const newDevice = settings.notify.events.newDevice;
  const list = devices.data?.devices ?? [];
  const canBypass = devices.data?.canBypass ?? false;
  const alarm = devices.data?.alarm;
  const formRow = form && (
    <Block>
      <PasswordForm mode={form} cancel={() => setForm(null)} done={() => {
        setForm(null);
        readAgain();
      }} />
    </Block>
  );

  return (
    <Card
      id="access" setting="access" title="Access" help={HELP}
      status={a.hasPassword ? <Chip tone="good"><Lock size={12} strokeWidth={2.4} />Password on</Chip> : undefined}
    >
      <Row setting="access.reach" label="Reachable from" help="The address Afflatus listens on (HOST): 127.0.0.1 is this computer only, 0.0.0.0 every network it is on. Set when Afflatus starts.">
        <span className="text-body text-ink-2">{listen ? reachSaid(listen) : "…"} {where && <span className="font-mono text-ink-3">· {where}</span>}</span>
      </Row>
      {!a.hasPassword ? (
        <>
          <Row setting="access.password" label="Password" help={HELP}>
            <span className="grow text-body text-ink-2">none: anyone who reaches {where || "it"} can use Afflatus</span>
            {!form && <Button size="sm" tone="primary" onClick={() => setForm("set")}>Set a password…</Button>}
          </Row>
          {formRow}
        </>
      ) : (
        <>
          <Row setting="access.password" label="Password" help={HELP}>
            <span className="grow text-body text-ink-2">{a.passwordSetAt ? `set ${dayMonth(a.passwordSetAt)}` : "set"}</span>
            {!form && <Button size="sm" onClick={() => setForm("change")}>Change…</Button>}
            {!form && <Button size="sm" onClick={() => setForm("off")}>Turn off…</Button>}
          </Row>
          {formRow}
        </>
      )}
      {alarm && (
        <Row tone="warn" label="Sign-ins refused" help="Too many wrong tries: everyone waits a minute, or one address waits 15 minutes. Devices signed in go on. Behind a proxy every visitor shares its address, so its waits are everyone's.">
          <span className="text-xs text-warn-ink">{alarm.said} ({when(alarm.at)})</span>
        </Row>
      )}
      <Row setting="access.local" label="From this computer" help={canBypass ? LOCAL_HELP : LOCAL_OFF_HELP}>
        <span className="flex flex-col items-end gap-1">
          <Toggle on={a.localNoPassword && canBypass} disabled={!canBypass && !a.localNoPassword} onChange={(localNoPassword) => change({ localNoPassword })} label="No password needed" />
          {!canBypass && <span className="text-xs text-ink-3">not offered: Afflatus listens on this computer only</span>}
          {canBypass && a.localNoPassword && <span className="text-xs text-warn-ink">a forwarder or a reverse proxy on this computer lets every visitor in</span>}
        </span>
      </Row>
      <Row setting="access.stay" label="Stay signed in" help={STAY_HELP}>
        <span className="w-[140px]"><Select size="sm" label="Stay signed in" value={String(a.stayDays)} onChange={(v) => change({ stayDays: Number(v) as AccessSettings["stayDays"] })} options={STAY} /></span>
      </Row>
      <Row setting="access.codes" label="Reset codes go to" help={CODES_HELP}>
        <span className="flex flex-col items-end gap-2">
          {telegramSet && <Checkbox checked={a.resetTelegram} onChange={(resetTelegram) => change({ resetTelegram })} className="text-body">Telegram <span className="text-xs text-ink-3">your bot's chat; in a group chat, every member sees the code</span></Checkbox>}
          <Checkbox checked disabled onChange={() => {}} className="text-body">This computer <span className="text-xs text-ink-3">its console and log file: always</span></Checkbox>
        </span>
      </Row>
      <Row setting="access.newDevice" label="Tell me of a new device" help={NEW_HELP}>
        {/* a channel on but not set up sends nothing: said as such, not as a notice that never comes */}
        <Toggle on={newDevice.telegram} onChange={(telegram) => change({ newDevice: { telegram } })} label={telegramSet ? "On Telegram" : "On Telegram, once it is set"} />
      </Row>
      {a.hasPassword && (
        <Row setting="access.metrics" label="Metrics token" help={METRICS_HELP}>
          {token ? (
            <>
              <code className="min-w-0 truncate rounded-md bg-raised px-2 py-1 font-mono text-meta">{token}</code>
              <Button size="sm" onClick={() => copy(token)}>{copied ? "Copied" : "Copy"}</Button>
            </>
          ) : (
            <span className="grow text-body text-ink-2">{a.hasMetricsToken ? "set: Prometheus reads /metrics with it" : "none: /metrics needs a session"}</span>
          )}
          <Button size="sm" disabled={save.isPending} onClick={() => change({ metrics: true })}>{a.hasMetricsToken ? "Make a new one" : "Make a token"}</Button>
          {a.hasMetricsToken && <Button size="sm" tone="quiet" disabled={save.isPending} onClick={() => { setToken(null); change({ metrics: false }); }}>Take off</Button>}
        </Row>
      )}
      {asking && <PasswordAsk said={asking.said} busy={save.isPending} onConfirm={(password) => save.mutate({ patch: asking.patch, password })} onCancel={() => setAsking(null)} />}
      {a.hasPassword && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2.5 px-gutter pt-3 pb-1.5">
            <span className="text-body font-bold">Signed in now</span>
            <span className="text-xs text-ink-3">{plural(list.length, "device")}</span>
            <span className="grow" />
            {list.length > 0 && <TwoStep label="Sign out everywhere" title="Sign out every device, this one too" note="Every device, this one too" yes="Sign out everywhere" busy={out.isPending} onYes={() => out.mutate("everywhere")} />}
          </div>
          {list.map((d) => <DeviceRow key={d.id} d={d} busy={out.isPending} onOut={() => out.mutate(d)} />)}
          {session.data?.localNoPassword && !session.data.session && (
            <span className="px-gutter py-2 text-xs text-ink-3">This computer is in without a session: no password needed here.</span>
          )}
        </div>
      )}
      <Block>
        <span className="text-xs leading-normal text-ink-3">
          Locks Afflatus for anyone who reaches it over the network: the library, renders, the GPUs and pods, the keys it holds. Not the files on this computer: those are your account's and your disk's to protect.
        </span>
      </Block>
    </Card>
  );
}
