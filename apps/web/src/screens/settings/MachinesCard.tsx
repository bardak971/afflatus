import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shortGpu } from "@afflatus/core";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Lock, LockOpen, MoreHorizontal, Star, Trash2 } from "lucide-react";
import { useOpenComfyUI } from "../../actions";
import { ask } from "../../Confirm";
import type { MenuItem } from "../../ContextMenu";
import { api, type Machine, type MachineProbe, type MachineState } from "../../api";
import { useMenu } from "../../ContextMenu";
import { useQueue, useSettings } from "../../data";
import { gb, plural, usd } from "../../format";
import { useCopied, useMedia, useSecond } from "../../hooks";
import { machineLabel, machineState, rateParts, rentedSaid } from "../../machines";
import { useQueueOps } from "../../queueOps";
import { queryKeys } from "../../queryKeys";
import { Button, ButtonLink, cx, ErrorNote, fieldClass, Segmented } from "../../ui";
import { AccessRow, useAccessActions } from "./AccessRow";
import { useRentedOps } from "../../rentedOps";
import { RentRow } from "./RentedCard";
import { RentedHead, RentedRows } from "./RentedRows";
import { Block, Card, Row, Status } from "./Rows";
import { COLUMNS, WIDE } from "./wide";

const MachineMenuBody = lazy(() => import("../../MachineMenu").then((m) => ({ default: m.MachineMenuBody })));

/** What a machine takes, as the card's switch says it. */
const TAKES: Array<{ value: Machine["takes"]; label: string; tip: string }> = [
  { value: "all", label: "Everything", tip: "Pictures, clips, finishes: whatever waits" },
  { value: "image", label: "Pictures", tip: "Only pictures: a small card for pictures while another one renders video" },
  { value: "video", label: "Videos", tip: "Only clips, sounds, finishes and slow motion" },
];

const WHY_SEVERAL = "Each ComfyUI is one machine the queue sends work to: a second GPU of this computer (a ComfyUI of its own, started with --cuda-device 1 --port 8189), another computer, a rented instance. One line of jobs; each machine runs one at a time, the one that would finish it soonest (the model already loaded there, its own learned speed). A job pinned to a machine runs there. The first one is the one the setup, the downloads and the node packs talk to.";

/**
 * Whether an address is out on the internet over plain http: anyone who finds it could run code on that ComfyUI. Loopback,
 * the private ranges, Tailscale's (100.64/10) and .local names are not.
 */
export function publicPlainHttp(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host === "::1" || /^f[cd]/.test(host)) return false;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return !host.includes(".") ? false : true;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254));
}


/**
 * A machine's facts, the line under its card's head: its GPU and memory, a pod's rate and place, ComfyUI's and the node
 * pack's versions, and the lock. The long "cuda:0 NVIDIA … : cudaMallocAsync" chip it replaces said the same at length.
 */
function MachineFacts({ probe, state, rented }: { probe: MachineProbe | undefined; state: MachineState | undefined; rented: boolean }) {
  const r = state?.rented;
  const gpu = probe?.device ? shortGpu(probe.device) : r?.gpu ? shortGpu(r.gpu) : undefined;
  const access = probe?.access;
  const parts: ReactNode[] = [
    gpu && <span key="gpu"><b className="font-semibold text-ink-2">{gpu}</b>{probe?.vramTotal ? ` · ${gb(probe.vramTotal)}` : ""}</span>,
    r && (r.rate || r.dataCenter) && <span key="rate" data-tip={rateParts(r) ?? undefined}>{r.rate ? <><b className="font-semibold text-ink-2">{usd(r.rate)}</b>/h</> : null}{r.rate && r.dataCenter ? " · " : ""}{r.dataCenter}</span>,
    probe?.online && probe.version && (
      <span key="versions">
        ComfyUI <b className="font-mono font-semibold text-ink-2">{probe.version.replace(/^v/, "")}</b>
        {probe.pack ? <> · node pack <b className="font-mono font-semibold text-ink-2">{probe.pack}</b></> : rented ? " · no node pack" : null}
      </span>
    ),
    access?.state === "locked" && <span key="lock" className="inline-flex items-center gap-1 font-semibold text-good" data-tip={access.fixed ? (rented ? "Locked from its first second: Afflatus set its token in the pod's environment" : "Locked by its start settings (AFFLATUS_TOKEN)") : "Locked: every call needs its token, which Afflatus keeps"}><Lock size={12} strokeWidth={2.2} />Locked</span>,
    access?.state === "open" && <span key="lock" className="inline-flex items-center gap-1 font-semibold text-warn-ink"><LockOpen size={12} strokeWidth={2.2} />Not locked</span>,
    access?.state === "wrong" && <span key="lock" className="inline-flex items-center gap-1 font-semibold text-warn-ink"><Lock size={12} strokeWidth={2.2} />Locked with another token</span>,
  ].filter(Boolean);
  const noPack = probe?.online && !probe.pack && !rented;
  if (!parts.length && !noPack) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-3">
      {parts}
      {noPack && <ButtonLink href="/api/comfy/node-pack.zip" download tone="danger" size="sm">Node pack not loaded: download it</ButtonLink>}
    </span>
  );
}

/** The settings saved with the machines as they are now, and what reads them asked again. */
function useSaveMachines() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (machines: Machine[]) => api.saveSettings({ machines }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      for (const queryKey of [queryKeys.machines(), queryKeys.queue(), queryKeys.setup(), queryKeys.runpodPods(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
    },
  });
}

/** Each ComfyUI asked now: whether it answers, its GPU, its node pack. */
export function useMachineProbes(enabled = true) {
  return useQuery({ queryKey: queryKeys.machines(), queryFn: ({ signal }) => api.machines({ signal }), enabled, staleTime: 10_000 });
}

/** A ComfyUI added by its address: its id the next free one ("m3"), its name the user's to give. */
export function AddMachineCard() {
  const settings = useSettings();
  const save = useSaveMachines();
  const [url, setUrl] = useState("");
  const all = settings.data?.machines ?? [];
  const add = () => {
    // an id no machine had before: one removed keeps its pause and its learned speed under its id, and a new one taking
    // that id took them on (the time, to the millisecond, in base 36)
    const id = `m${Date.now().toString(36)}`;
    save.mutate([...all, { id, name: "", url: url.trim(), dir: "", takes: "all", families: {}, tokenEnd: "" }], { onSuccess: () => setUrl("") });
  };
  const exposed = url.trim() !== "" && publicPlainHttp(url.trim());
  return (
    <Card title="Add a ComfyUI" help={WHY_SEVERAL}>
      <Row setting="comfy.machines" label="ComfyUI URL" htmlFor="comfy-add" help="Another GPU of this computer (its own ComfyUI on another port), another computer on your network, or a rented instance. Added, it takes work from the queue at once; pause it from its card or the status bar.">
        <input id="comfy-add" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8189" spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={add} disabled={!url.trim() || save.isPending}>Add</Button>
      </Row>
      <RentRow />
      {(exposed || save.isError) && (
        <Block>
          {exposed && <ErrorNote>A public address over plain http: anyone who finds it can run code on that ComfyUI. Reach it through Tailscale or an SSH tunnel, or put it behind a proxy that asks for a password.</ErrorNote>}
          {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
        </Block>
      )}
    </Card>
  );
}

/** "Pause all", above the machines' cards. */
export function MachinesHead() {
  const queue = useQueue();
  const ops = useQueueOps();
  const machines = queue.data?.machines ?? [];
  // a pod starting (a deployed one's first start too, RunPod saying it runs while its image is pulled) is neither offline
  // nor stopped: the words every screen says (machineState)
  const word = (w: string) => machines.filter((m) => machineState(m) === w).length;
  const said = [`${machines.filter((m) => m.running).length} rendering`, `${machines.filter((m) => m.paused).length} paused`, `${word("starting")} starting`, `${word("offline") + word("locked")} offline`, `${word("stopped")} stopped`].filter((x) => !x.startsWith("0 ")).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-1">
      <span className="text-[14px] font-bold">{plural(machines.length, "ComfyUI")}</span>
      {said && <span className="text-xs text-ink-2">{said}</span>}
      <span className="grow" />
      {queue.data?.paused
        ? <Button onClick={() => ops.resume.mutate(undefined)} disabled={ops.resume.isPending}>Resume all</Button>
        : <Button onClick={() => ops.pause.mutate(undefined)} disabled={ops.pause.isPending}>Pause all</Button>}
    </div>
  );
}

/** One ComfyUI of several: its name, its address and test, its folder, what it takes, its node pack, its state and menu. */
export function MachineCard({ machine, index, probe, state, onFold }: { machine: Machine; index: number; probe: MachineProbe | undefined; state: MachineState | undefined; /** Past four machines: folds it back to its line. */ onFold?(): void }) {
  const settings = useSettings();
  const save = useSaveMachines();
  const ops = useQueueOps();
  const client = useQueryClient();
  const menu = useMenu<true>();
  const all = settings.data?.machines ?? [];
  const [name, setName] = useState(machine.name);
  // the probe is read now and then; the queue's live state says first that a ComfyUI answers again (a pod up after its
  // boot): the probe is read again then, and its failure from before is not shown meanwhile (a pod rendering showed the
  // 404 its proxy gave while ComfyUI was starting)
  const answers = state?.online !== false && state?.rented?.answers !== false;
  useEffect(() => {
    if (answers && probe?.online === false) void client.invalidateQueries({ queryKey: queryKeys.machines() });
  }, [answers, probe?.online, client]);
  const failing = probe?.online === false && !answers ? probe : null;
  const [url, setUrl] = useState(machine.url);
  const [dir, setDir] = useState(machine.dir);
  useEffect(() => setName(machine.name), [machine.name]);
  useEffect(() => setUrl(machine.url), [machine.url]);
  useEffect(() => setDir(machine.dir), [machine.dir]);
  const put = (change: Partial<Machine>) => save.mutate(all.map((m) => (m.id === machine.id ? { ...m, ...change } : m)));
  // saved first when the address changed, then every machine asked again: only reads, nothing is queued or loaded
  const test = useMutation({
    mutationFn: async () => {
      if (url.trim() !== machine.url) await save.mutateAsync(all.map((m) => (m.id === machine.id ? { ...m, url: url.trim() } : m)));
      return api.machines();
    },
    onSuccess: (probes) => client.setQueryData(queryKeys.machines(), probes),
  });
  const label = machineLabel(machine);
  const rented = Boolean(machine.rented);
  // a rented pod is removed by its own route: a list sent whole keeps every rented machine (one dropped by an old list would
  // bill with nothing watching it)
  const removeRented = useMutation({
    mutationFn: () => api.removeMachine(machine.id),
    onSuccess: () => {
      for (const queryKey of [queryKeys.settings(), queryKeys.machines(), queryKeys.queue(), queryKeys.setup(), queryKeys.runpodPods(), queryKeys.rentedSpending()]) void client.invalidateQueries({ queryKey });
    },
  });
  // one Start and Stop for the head and the rows: a Delete under way holds Start and Stop too
  const rentedOps = useRentedOps();
  const billing = rented && state?.rented && state.rented.status !== "EXITED" && state.rented.status !== "GONE" && state.rented.status !== "TERMINATED";
  // a rented pod that came up or went: what was asked of it a moment ago (not answering) no longer holds
  const podStatus = state?.rented?.status;
  useEffect(() => {
    if (podStatus) void client.invalidateQueries({ queryKey: queryKeys.machines() });
  }, [podStatus, client]);
  // asked for by its id (?machine=, a menu's "Terminate…", a deploy): its card is brought into view, by the least scroll
  // that shows it (scrolled to the top, a new pod's card sat against the window's edge)
  const asked = new URLSearchParams(useSearch()).get("machine") === machine.id;
  useEffect(() => {
    if (asked) document.getElementById(`machine-${machine.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [asked, machine.id]);
  // a rented pod's head says its own state (stopped, starting, running and its cost), with Start or Stop
  const status = rented ? <RentedHead machine={machine} state={state} ops={rentedOps} /> : !probe ? null : state?.paused
    ? <span className="text-[12.5px] font-semibold text-ink-2">Ⅱ Paused</span>
    : <Status ok={probe.online}>{probe.online ? (state?.running ? "Rendering" : "Answering") : "Not answering"}</Status>;
  // its ComfyUI in a tab of its own, logged in by a one-time code (lock-api.ts pageUrl): once it answers (a pod, once it runs)
  const openComfy = useOpenComfyUI();
  const canOpen = rented ? state?.rented?.status === "RUNNING" && !state.rented.booting && state.rented.answers !== false : Boolean(probe?.online);
  const access = useAccessActions(machine.id, label, probe);
  const { copied: addressCopied, copy: copyAddress } = useCopied();
  const removeNote = rented ? (billing ? "From Afflatus only: it keeps running and billing on RunPod, and nothing stops it any more." : "From Afflatus only: the pod stays on RunPod, as it is.") : "What it rendered stays; waiting jobs go elsewhere.";
  // the card's own items in its menu, after the machine's: its token, its address, the order, removing it
  const extra: MenuItem[] = [
    ...access.items,
    { label: addressCopied ? "Address copied" : "Copy its address", icon: <Copy size={14} />, run: () => copyAddress(machine.url) },
    ...(all.length > 1 && index > 0 ? [{ label: "Make it the first", icon: <Star size={14} />, note: "setup, downloads, node packs", run: () => save.mutate([machine, ...all.filter((m) => m.id !== machine.id)]) }] : []),
    ...(all.length > 1 ? [{ label: "Remove from Afflatus…", icon: <Trash2 size={14} />, danger: true, run: () => void ask({ title: `Remove ${label}?`, text: removeNote, yes: "Remove" }).then((yes) => yes && (rented ? removeRented.mutate() : save.mutate(all.filter((m) => m.id !== machine.id)))) }] : []),
  ];
  return (
    <Card
      id={`machine-${machine.id}`}
      title={(
        <span className="flex items-center gap-2">
          {onFold && <button type="button" aria-label={`Fold ${label}`} className="text-ink-3 hover:text-ink" onClick={onFold}><ChevronDown size={14} /></button>}
          {/* its name, renamed in place: what the status bar, the Queue and the menus call it; empty, its address */}
          <input
            id={`comfy-name-${machine.id}`}
            aria-label={`${label}: its name`}
            data-tip="Click to rename: what the status bar, the Queue and the menus call it. Empty: its address"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() !== machine.name && put({ name: name.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            placeholder={label}
            maxLength={40}
            className="field-sizing-content min-w-12 max-w-[320px] rounded-md border border-transparent bg-transparent px-1 -mx-1 text-[15px] font-bold text-ink outline-none placeholder:text-ink hover:border-line focus:border-accent"
          />
          {all.length > 1 && index === 0 && <span className="rounded-md bg-raised px-2 py-0.5 text-[11.5px] font-semibold text-ink-2" data-tip="The setup, the downloads and the node packs talk to it">the first</span>}
        </span>
      )}
      label={label}
      status={(
        <span className="flex items-center gap-2">
          {status}
          {state?.paused && <Button size="sm" onClick={() => ops.resume.mutate(machine.id)}>Resume</Button>}
          {canOpen && <Button size="sm" onClick={() => openComfy.mutate(machine.id)} disabled={openComfy.isPending} data-tip="Its ComfyUI in a new tab, logged in">Open ComfyUI <ExternalLink size={12} /></Button>}
          <button type="button" aria-label={`${label}: menu`} className="grid size-8 place-items-center rounded-lg border border-line-strong hover:bg-hover" onClick={(e) => menu.open(e, true)}>
            <MoreHorizontal size={14} />
          </button>
          {menu.menu && <Suspense fallback={null}><MachineMenuBody at={menu.menu.at} machine={machine.id} extra={extra} onClose={menu.close} /></Suspense>}
        </span>
      )}
      sub={<MachineFacts probe={probe} state={state} rented={rented} />}
    >
      {!rented && <Row label="ComfyUI URL" htmlFor={`comfy-url-${machine.id}`} help="The address this ComfyUI listens on. Test again saves it first when it changed; it only reads what ComfyUI has.">
        <input id={`comfy-url-${machine.id}`} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Connecting…" : url.trim() !== machine.url ? "Save and test" : "Test again"}</Button>
      </Row>}
      {/* a rented pod that is not running does not answer: its head says so, not a failure here */}
      {(test.isError || save.isError || (failing && (!rented || (state?.rented?.status === "RUNNING" && !state.rented.booting))) || (!rented && publicPlainHttp(machine.url))) && (
        <Block>
          {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
          {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
          {failing?.error && !state?.rented?.booting && <ErrorNote>{failing.error}</ErrorNote>}
          {publicPlainHttp(machine.url) && <ErrorNote>A public address over plain http: anyone who finds it can run code on this ComfyUI. Reach it through Tailscale or an SSH tunnel, or put it behind a proxy that asks for a password.</ErrorNote>}
        </Block>
      )}
      {!rented && <Row label="Folder on this computer" htmlFor={`comfy-dir-${machine.id}`} help="Optional: this ComfyUI's own folder (the one with main.py), when it is on this computer. Leave it empty for another computer or a rented instance.">
        <input id={`comfy-dir-${machine.id}`} value={dir} onChange={(e) => setDir(e.target.value)} placeholder="empty when it runs elsewhere" spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={() => put({ dir: dir.trim() })} disabled={save.isPending || dir.trim() === machine.dir}>Save</Button>
      </Row>}
      <Row label="Takes" help="What the queue gives this machine. A job pinned to it (dragged onto its lane in the Queue) runs there whatever this says.">
        <Segmented oneLine label={`What ${label} takes`} value={machine.takes} options={TAKES} onChange={(takes) => put({ takes })} />
      </Row>
      {rented && <RentedRows machine={machine} state={state} put={(r) => put({ rented: r })} ops={rentedOps} remove={() => save.mutate(all.filter((m) => m.id !== machine.id))} />}
      <AccessRow id={machine.id} label={label} probe={probe} url={machine.url} rented={rented} />
      {(access.failed || removeRented.isError) && <Block>{access.failed && <ErrorNote>{access.failed.message}</ErrorNote>}{removeRented.isError && <ErrorNote>{removeRented.error.message}</ErrorNote>}</Block>}
      {/* the token's end at the foot of one of your own (a pod's foot is its address and Terminate) */}
      {!rented && probe?.tokenEnd && (
        <div className="flex items-center gap-3 bg-raised px-[18px] py-2.5 text-xs">
          <span className="font-mono text-ink-3" data-tip="The token's end: the token itself stays in Afflatus">token ••••••••{probe.tokenEnd}</span>
          <button type="button" className="font-semibold text-ink-2 hover:text-ink" onClick={access.copyToken}>{access.copied ? "Copied" : "Copy"}</button>
          <span className="grow" />
          <span className="inline-flex items-center gap-1 text-ink-3">Renew, Unlock and Remove: in <MoreHorizontal size={13} aria-label="its menu" /></span>
        </div>
      )}
    </Card>
  );
}

/** Past this many machines each is one line, its card opening on a click: fifteen full cards are a long way down. */
const LINES_PAST = 4;

const TAKES_SAID: Record<Machine["takes"], string> = { all: "takes everything", image: "pictures only", video: "videos only" };

/** One machine in a line (past four of them): its state, its GPU, what it takes. A click opens its card. */
function MachineLine({ machine, index, probe, state, onOpen }: { machine: Machine; index: number; probe: MachineProbe | undefined; state: MachineState | undefined; onOpen(): void }) {
  const label = machineLabel(machine);
  // a pod's boot counts by the second here too, on the clock the pill and its card read
  const now = useSecond(Boolean(state?.rented?.boot));
  const said = state?.rented && (state.rented.status !== "RUNNING" || state.rented.booting) ? rentedSaid(state.rented, now) : state?.paused ? "paused" : probe && !probe.online ? "not answering" : state?.running ? "rendering" : probe ? "answering" : "…";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label}: open its settings`}
      id={`machine-${machine.id}`}
      className="grid w-full min-w-0 grid-cols-[14px_minmax(120px,1fr)_110px_minmax(0,1fr)_120px] items-center gap-3 border-b border-line/60 px-[18px] py-2.5 text-left text-[13px] last:border-b-0 hover:bg-hover"
    >
      <ChevronRight size={13} className="text-ink-3" />
      <span className="flex min-w-0 items-baseline gap-2"><span className="truncate font-semibold">{label}</span>{index === 0 && <span className="shrink-0 text-xs text-ink-3">the first</span>}</span>
      <span className={cx("truncate text-xs font-semibold", said === "not answering" ? "text-warn-ink" : said === "paused" || (state?.rented && state.rented.status !== "RUNNING") ? "text-ink-2" : "text-good")}>{said}</span>
      <span className="truncate font-mono text-xs text-ink-2">{probe?.device ?? machine.url}</span>
      <span className="text-xs text-ink-2">{TAKES_SAID[machine.takes]}</span>
    </button>
  );
}

/** The machines' cards; past four, a line each, a card opening on a click. */
export function MachineCards({ machines, probes, states }: { machines: Machine[]; probes: MachineProbe[] | undefined; states: MachineState[] | undefined }) {
  // the machine asked for by its id (?machine=) opens as a card, past four as well
  const asked = new URLSearchParams(useSearch()).get("machine");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(asked ? [asked] : []));
  // asked again while the page is open (a menu's "Terminate…"): its card opens, folded or not
  useEffect(() => {
    if (asked) setOpen((was) => (was.has(asked) ? was : new Set([...was, asked])));
  }, [asked]);
  const toggle = (id: string) => setOpen((was) => {
    const next = new Set(was);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const wide = useMedia(WIDE);
  const card = (m: Machine, i: number, onFold?: () => void) => <MachineCard key={m.id} machine={m} index={i} probe={probes?.find((p) => p.id === m.id)} state={states?.find((x) => x.id === m.id)} onFold={onFold} />;
  if (machines.length <= LINES_PAST) {
    const cards = machines.map((m, i) => card(m, i));
    if (!wide || cards.length < 2) return <>{cards}</>;
    // side by side in a wide window, in turn (the first and third left, the second and fourth right), each column as
    // tall as its own cards: a rented pod's card is longer than one at home
    return (
      <div className={COLUMNS}>
        <div className="flex min-w-0 flex-col gap-4">{cards.filter((_, i) => i % 2 === 0)}</div>
        <div className="flex min-w-0 flex-col gap-4">{cards.filter((_, i) => i % 2 === 1)}</div>
      </div>
    );
  }
  // the lines in one list, broken where a card is open
  const runs: Array<{ open: boolean; items: Array<{ m: Machine; i: number }> }> = [];
  machines.forEach((m, i) => {
    const isOpen = open.has(m.id);
    const last = runs.at(-1);
    if (last && !last.open && !isOpen) last.items.push({ m, i });
    else runs.push({ open: isOpen, items: [{ m, i }] });
  });
  // one column of lines, however wide the window: a line's few words do not fill twice that
  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      {runs.map((run) => (run.open
        ? card(run.items[0]!.m, run.items[0]!.i, () => toggle(run.items[0]!.m.id))
        : (
          <section key={run.items[0]!.m.id} className="overflow-hidden rounded-[14px] border border-line bg-panel shadow-card">
            {run.items.map(({ m, i }) => <MachineLine key={m.id} machine={m} index={i} probe={probes?.find((p) => p.id === m.id)} state={states?.find((x) => x.id === m.id)} onOpen={() => toggle(m.id)} />)}
          </section>
        )))}
    </div>
  );
}
