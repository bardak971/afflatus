import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Monitor, Smartphone, Tablet } from "lucide-react";
import { api, ApiError, type AccessSettings, type SignedDevice, type SignedDevices } from "../../api";
import { useSettings } from "../../data";
import { dayMonth, plural, when } from "../../format";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Select } from "../../Select";
import { Button, Checkbox, Chip, cx, ErrorNote, fieldClass, Toggle, TwoStep } from "../../ui";
import { Block, Card, Row } from "./Rows";

/**
 * Settings › Interface › Access: the optional password (access.ts). Where Afflatus listens, the password itself (set,
 * change, turn off: each asks for the current one), whether this computer needs it, how long a device stays signed in,
 * where reset codes go, and the devices signed in now.
 */

const HELP = "A password for Afflatus. Set, every page and API call needs a signed-in device (the probe's /api/health, the sign-in itself and a download ComfyUI fetches excepted), but from this computer while \"From this computer\" is on. Forgot it: Forgot password? on the sign-in sends a 6-digit code to Telegram or to this computer's console and data/logs/afflatus.log. Lost every way in: stop Afflatus and run Afflatus.bat reset-password (./afflatus.sh reset-password; from the sources pnpm start reset-password; Docker: docker compose run --rm afflatus node apps/server/dist/index.mjs reset-password), or start it once with AFFLATUS_RESET_PASSWORD=1. Either removes the password and signs every device out.";
const LOCAL_HELP = "A request from the computer Afflatus runs on (a loopback address, asked as localhost, through no proxy) gets in without the password: whoever sits at it has the files already. In Docker the host's requests come through Docker's network, so nothing is exempt there. A reverse proxy on this computer that passes neither the name it is reached by nor a forwarding header (nginx's default Host) would count as this computer: turn this off when you put one in front.";
const STAY_HELP = "How long a device stays signed in when \"Remember this device\" was ticked at its sign-in. Not ticked: until the browser closes, or 12 h without use. A change counts from the next sign-in.";
const CODES_HELP = "Where Forgot password? may send a 6-digit code (valid 10 minutes, once, one a minute). This computer always: Afflatus's console and data/logs/afflatus.log (docker logs on Docker), which only someone at the machine reads. Telegram: your bot's chat, once Telegram is set in Notifications.";
const NEW_HELP = "A notice when a device never seen before signs in: its browser and address. Where it goes is set in Notifications › What (Telegram by default).";

const STAY: Array<{ value: string; label: string }> = [1, 7, 30, 90].map((d) => ({ value: String(d), label: plural(d, "day") }));

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
  const box = cx("h-9 w-56 text-[13px]", fieldClass);
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      {mode !== "set" && (
        <label className="flex items-center justify-between gap-3 text-[13px]">
          Current password
          <input type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={box} />
        </label>
      )}
      {mode !== "off" && (
        <label className="flex items-center justify-between gap-3 text-[13px]">
          {mode === "set" ? "Password" : "New password"}
          <input type="password" autoFocus={mode === "set"} autoComplete="new-password" placeholder="8 characters at least" value={fresh} onChange={(e) => setFresh(e.target.value)} className={box} />
        </label>
      )}
      {mode === "change" && <Checkbox checked={signOutOthers} onChange={setSignOutOthers} className="self-end text-[13px]">Sign out every other device</Checkbox>}
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
    <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 px-[18px] py-2 sm:grid-cols-[30px_minmax(0,1fr)_150px_110px_auto]">
      <DeviceIcon name={d.name} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] font-semibold">{d.name} {d.here && <span className="text-[11.5px] text-good">this device</span>}</span>
        <span className="text-[11.5px] text-ink-3">first seen {dayMonth(d.firstSeen)}</span>
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
  const save = useMutation({
    mutationFn: (access: Partial<Pick<AccessSettings, "localNoPassword" | "stayDays" | "resetTelegram">>) => api.saveSettings({ access }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
    onError: sayFailed("The access settings were not saved"),
  });
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
        <span className="text-[12.5px] text-ink-2">{listen ? reachSaid(listen) : "…"} {where && <span className="font-mono text-ink-3">· {where}</span>}</span>
      </Row>
      {!a.hasPassword ? (
        <>
          <Row setting="access.password" label="Password" help={HELP}>
            <span className="grow text-[12.5px] text-ink-2">none: anyone who reaches {where || "it"} can use Afflatus</span>
            {!form && <Button size="sm" tone="primary" onClick={() => setForm("set")}>Set a password…</Button>}
          </Row>
          {formRow}
        </>
      ) : (
        <>
          <Row setting="access.password" label="Password" help={HELP}>
            <span className="grow text-[12.5px] text-ink-2">{a.passwordSetAt ? `set ${dayMonth(a.passwordSetAt)}` : "set"}</span>
            {!form && <Button size="sm" onClick={() => setForm("change")}>Change…</Button>}
            {!form && <Button size="sm" onClick={() => setForm("off")}>Turn off…</Button>}
          </Row>
          {formRow}
        </>
      )}
      <Row setting="access.local" label="From this computer" help={LOCAL_HELP}>
        <Toggle on={a.localNoPassword} onChange={(localNoPassword) => save.mutate({ localNoPassword })} label="No password needed" />
      </Row>
      <Row setting="access.stay" label="Stay signed in" help={STAY_HELP}>
        <span className="w-[140px]"><Select size="sm" label="Stay signed in" value={String(a.stayDays)} onChange={(v) => save.mutate({ stayDays: Number(v) as AccessSettings["stayDays"] })} options={STAY} /></span>
      </Row>
      <Row setting="access.codes" label="Reset codes go to" help={CODES_HELP}>
        <span className="flex flex-col items-end gap-2">
          {telegramSet && <Checkbox checked={a.resetTelegram} onChange={(resetTelegram) => save.mutate({ resetTelegram })} className="text-[13px]">Telegram <span className="text-xs text-ink-3">your bot's chat</span></Checkbox>}
          <Checkbox checked disabled onChange={() => {}} className="text-[13px]">This computer <span className="text-xs text-ink-3">its console and log file: always</span></Checkbox>
        </span>
      </Row>
      <Row setting="access.newDevice" label="Tell me of a new device" help={NEW_HELP}>
        <span className="text-[12.5px] text-ink-2">
          {/* a channel ticked but not set up sends nothing: said as such, not as a notice that never comes */}
          {(() => {
            const on = [newDevice.telegram && telegramSet && "Telegram", newDevice.discord && settings.notify.hasDiscordWebhook && "Discord"].filter(Boolean);
            return on.length ? `a notice on ${on.join(" and ")}` : newDevice.telegram && !telegramSet ? "on Telegram, once it is set" : "off";
          })()}
          <span className="text-ink-3"> (Notifications › What)</span>
        </span>
      </Row>
      {a.hasPassword && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2.5 px-[18px] pt-3 pb-1.5">
            <span className="text-[13px] font-bold">Signed in now</span>
            <span className="text-xs text-ink-3">{plural(list.length, "device")}</span>
            <span className="grow" />
            {list.length > 0 && <TwoStep label="Sign out everywhere" title="Sign out every device, this one too" note="Every device, this one too" yes="Sign out everywhere" busy={out.isPending} onYes={() => out.mutate("everywhere")} />}
          </div>
          {list.map((d) => <DeviceRow key={d.id} d={d} busy={out.isPending} onOut={() => out.mutate(d)} />)}
          {session.data?.local && !session.data.session && a.localNoPassword && (
            <span className="px-[18px] py-2 text-xs text-ink-3">This computer is in without a session: no password needed here.</span>
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
