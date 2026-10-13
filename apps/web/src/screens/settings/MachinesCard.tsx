import { lazy, Suspense, useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { api, type Machine, type MachineProbe, type MachineState } from "../../api";
import { useMenu } from "../../ContextMenu";
import { useQueue, useSettings } from "../../data";
import { gb } from "../../format";
import { machineLabel } from "../../machines";
import { useQueueOps } from "../../queueOps";
import { queryKeys } from "../../queryKeys";
import { Button, ButtonLink, cx, ErrorNote, fieldClass, Segmented, TwoStep } from "../../ui";
import { AccessRow } from "./AccessRow";
import { RunpodAdd } from "./RentedCard";
import { RentedHead, RentedRows } from "./RentedRows";
import { Block, Card, Fact, Row, Status } from "./Rows";

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

/** The settings saved with the machines as they are now, and what reads them asked again. */
function useSaveMachines() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (machines: Machine[]) => api.saveSettings({ machines }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      for (const queryKey of [queryKeys.machines(), queryKeys.queue(), queryKeys.setup()]) void client.invalidateQueries({ queryKey });
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
    const ids = new Set(all.map((m) => m.id));
    let n = all.length + 1;
    while (ids.has(`m${n}`)) n++;
    save.mutate([...all, { id: `m${n}`, name: "", url: url.trim(), dir: "", takes: "all", families: {}, tokenEnd: "" }], { onSuccess: () => setUrl("") });
  };
  const exposed = url.trim() !== "" && publicPlainHttp(url.trim());
  return (
    <Card title="Add a ComfyUI" help={WHY_SEVERAL}>
      <Row setting="comfy.machines" label="ComfyUI URL" htmlFor="comfy-add" help="Another GPU of this computer (its own ComfyUI on another port), another computer on your network, or a rented instance. Added, it takes work from the queue at once; pause it from its card or the status bar.">
        <input id="comfy-add" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8189  —  another GPU, another computer, a rented instance" spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={add} disabled={!url.trim() || save.isPending}>Add</Button>
      </Row>
      <RunpodAdd />
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
  const said = [`${machines.filter((m) => m.running).length} rendering`, `${machines.filter((m) => m.paused).length} paused`, `${machines.filter((m) => m.online === false).length} offline`].filter((x) => !x.startsWith("0 ")).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-1">
      <span className="text-[14px] font-bold">{machines.length} ComfyUIs</span>
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
  // a rented pod that came up or went: what was asked of it a moment ago (not answering) no longer holds
  const podStatus = state?.rented?.status;
  useEffect(() => {
    if (podStatus) void client.invalidateQueries({ queryKey: queryKeys.machines() });
  }, [podStatus, client]);
  // asked for by its id (?machine=, a menu's "Delete the pod…"): its card is brought into view
  const asked = new URLSearchParams(useSearch()).get("machine") === machine.id;
  useEffect(() => {
    if (asked) document.getElementById(`machine-${machine.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [asked, machine.id]);
  // a rented pod's head says its own state (stopped, starting, running and its cost), with Start or Stop
  const status = rented ? <RentedHead machine={machine} state={state} /> : !probe ? null : state?.paused
    ? <span className="text-[12.5px] font-semibold text-ink-2">Ⅱ Paused</span>
    : <Status ok={probe.online}>{probe.online ? `${state?.running ? "Rendering" : "Answering"}${probe.device ? ` · ${probe.device}` : ""}` : "Not answering"}</Status>;
  return (
    <Card
      id={`machine-${machine.id}`}
      title={(
        <span className="flex items-baseline gap-2">
          {onFold && <button type="button" aria-label={`Fold ${label}`} className="self-center text-ink-3 hover:text-ink" onClick={onFold}><ChevronDown size={14} /></button>}
          {label}{index === 0 && <span className="text-xs font-normal text-ink-3">the first: setup, downloads, node packs</span>}
        </span>
      )}
      label={label}
      status={(
        <span className="flex items-center gap-2">
          {status}
          {state?.paused && <Button size="sm" onClick={() => ops.resume.mutate(machine.id)}>Resume</Button>}
          <button type="button" aria-label={`${label}: menu`} className="grid size-7 place-items-center rounded-md border border-line hover:bg-hover" onClick={(e) => menu.open(e, true)}>
            <MoreHorizontal size={14} />
          </button>
          {menu.menu && <Suspense fallback={null}><MachineMenuBody at={menu.menu.at} machine={machine.id} onClose={menu.close} /></Suspense>}
        </span>
      )}
    >
      <Row label="Name" htmlFor={`comfy-name-${machine.id}`} help="What the status bar, the Queue and the menus call it. Empty: its address.">
        <input id={`comfy-name-${machine.id}`} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() !== machine.name && put({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} placeholder={label} maxLength={40} className={cx("h-10 min-w-0 grow text-sm", fieldClass)} />
      </Row>
      {!rented && <Row label="ComfyUI URL" htmlFor={`comfy-url-${machine.id}`} help="The address this ComfyUI listens on. Test again saves it first when it changed; it only reads what ComfyUI has.">
        <input id={`comfy-url-${machine.id}`} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "Connecting…" : url.trim() !== machine.url ? "Save and test" : "Test again"}</Button>
      </Row>}
      {/* a rented pod that is not running does not answer: its head says so, not a failure here */}
      {(test.isError || save.isError || (probe?.online === false && (!rented || state?.rented?.status === "RUNNING")) || (!rented && publicPlainHttp(machine.url))) && (
        <Block>
          {test.isError && <ErrorNote>{test.error.message}</ErrorNote>}
          {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
          {probe?.online === false && probe.error && <ErrorNote>{probe.error}</ErrorNote>}
          {publicPlainHttp(machine.url) && <ErrorNote>A public address over plain http: anyone who finds it can run code on this ComfyUI. Reach it through Tailscale or an SSH tunnel, or put it behind a proxy that asks for a password.</ErrorNote>}
        </Block>
      )}
      {probe?.online && (
        <Row label="ComfyUI" start>
          {probe.version && <Fact tip="ComfyUI version">v{probe.version.replace(/^v/, "")}</Fact>}
          {probe.device && <Fact tip={`${probe.device}: ${gb(probe.vramTotal ?? 0)} VRAM, ${gb(probe.vramFree ?? 0)} free`}><span className="max-w-[340px] truncate">{probe.device} · {gb(probe.vramTotal ?? 0)} · {gb(probe.vramFree ?? 0).replace(" GB", "")} free</span></Fact>}
          {probe.pack ? <Fact tip="The Afflatus node pack this ComfyUI loaded">node pack {probe.pack}</Fact> : <ButtonLink href="/api/comfy/node-pack.zip" download tone="danger" size="sm">Node pack not loaded: download it</ButtonLink>}
        </Row>
      )}
      {!rented && <Row label="Folder on this computer" htmlFor={`comfy-dir-${machine.id}`} help="Optional: this ComfyUI's own folder (the one with main.py), when it is on this computer. Leave it empty for another computer or a rented instance.">
        <input id={`comfy-dir-${machine.id}`} value={dir} onChange={(e) => setDir(e.target.value)} placeholder="empty when it runs elsewhere" spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
        <Button onClick={() => put({ dir: dir.trim() })} disabled={save.isPending || dir.trim() === machine.dir}>Save</Button>
      </Row>}
      <Row label="Takes" help="What the queue gives this machine. A job pinned to it (dragged onto its lane in the Queue) runs there whatever this says.">
        <Segmented oneLine label={`What ${label} takes`} value={machine.takes} options={TAKES} onChange={(takes) => put({ takes })} />
      </Row>
      {rented && <RentedRows machine={machine} state={state} put={(r) => put({ rented: r })} />}
      <AccessRow id={machine.id} label={label} probe={probe} url={machine.url} rented={rented} />
      {all.length > 1 && (
        <Row label="Order and removal" help="The first ComfyUI is the one the setup, the downloads and the node packs talk to. Removing one leaves what it rendered in the library; a job waiting for it goes to another machine.">
          {index > 0 && <Button size="sm" onClick={() => save.mutate([machine, ...all.filter((m) => m.id !== machine.id)])}>Make it the first</Button>}
          <TwoStep tone="danger" label="Remove" title={`Remove ${label}`} note={rented ? "from Afflatus only: the pod stays on RunPod, as it is" : "what it rendered stays; waiting jobs go elsewhere"} yes="Remove" onYes={() => save.mutate(all.filter((m) => m.id !== machine.id))} />
        </Row>
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
  const said = state?.paused ? "paused" : probe && !probe.online ? "not answering" : state?.running ? "rendering" : probe ? "answering" : "…";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label}: open its settings`}
      className="grid w-full min-w-0 grid-cols-[14px_minmax(120px,1fr)_110px_minmax(0,1fr)_120px] items-center gap-3 border-b border-line/60 px-[18px] py-2.5 text-left text-[13px] last:border-b-0 hover:bg-hover"
    >
      <ChevronRight size={13} className="text-ink-3" />
      <span className="flex min-w-0 items-baseline gap-2"><span className="truncate font-semibold">{label}</span>{index === 0 && <span className="shrink-0 text-xs text-ink-3">the first</span>}</span>
      <span className={cx("text-xs font-semibold", said === "not answering" ? "text-warn-ink" : said === "paused" ? "text-ink-2" : "text-good")}>{said}</span>
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
  const toggle = (id: string) => setOpen((was) => {
    const next = new Set(was);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const card = (m: Machine, i: number, onFold?: () => void) => <MachineCard key={m.id} machine={m} index={i} probe={probes?.find((p) => p.id === m.id)} state={states?.find((x) => x.id === m.id)} onFold={onFold} />;
  if (machines.length <= LINES_PAST) return <>{machines.map((m, i) => card(m, i))}</>;
  // the lines in one list, broken where a card is open
  const runs: Array<{ open: boolean; items: Array<{ m: Machine; i: number }> }> = [];
  machines.forEach((m, i) => {
    const isOpen = open.has(m.id);
    const last = runs.at(-1);
    if (last && !last.open && !isOpen) last.items.push({ m, i });
    else runs.push({ open: isOpen, items: [{ m, i }] });
  });
  return (
    <>
      {runs.map((run) => (run.open
        ? card(run.items[0]!.m, run.items[0]!.i, () => toggle(run.items[0]!.m.id))
        : (
          <section key={run.items[0]!.m.id} className="overflow-hidden rounded-[14px] border border-line bg-panel shadow-card">
            {run.items.map(({ m, i }) => <MachineLine key={m.id} machine={m} index={i} probe={probes?.find((p) => p.id === m.id)} state={states?.find((x) => x.id === m.id)} onOpen={() => toggle(m.id)} />)}
          </section>
        )))}
    </>
  );
}
