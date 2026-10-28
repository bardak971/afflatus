import { useEffect, useState, type ReactNode } from "react";
import { shortGpu } from "@afflatus/core";
import { Check, ExternalLink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ComfyProbe, type Settings } from "../api";
import { ask } from "../Confirm";
import { useSettings } from "../data";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { useCapsSave } from "../rentCaps";
import { GetFfmpeg } from "../GetFfmpeg";
import { Button, Chip, cx, ErrorNote, fieldClass } from "../ui";
import { INSTALLS } from "./settings/NoComfyCard";
import { CAP_DAY_WHY, CAP_MONTH_WHY, CapBox } from "./settings/RentedCard";
import { SecretField } from "./settings/SecretField";

/**
 * The first launch's page (where you render, card #20): one page in the Studio's place, shown once. It adds machines (the
 * user's ComfyUI, a RunPod key); it sets no mode: whether a ComfyUI of the user's own is expected follows from the machines
 * listed. Two questions, the second appearing once the first is answered; no Next or Back. Skip, Done, or leaving by the
 * rail ends it for good (App.tsx FirstLaunchGate); Settings › ComfyUI brings it back.
 */

/** What the first question was answered, or where it stands. */
type Comfy = "looking" | "found" | "have" | "install" | "added" | "none";

const hostOf = (url: string) => url.replace(/^https?:\/\//, "");

/** The settings saved, the page's copy set at once; the setup and the queue read again (a machine added or gone). */
function useSave() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof api.saveSettings>[0]) => api.saveSettings(patch),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      void client.invalidateQueries({ queryKey: queryKeys.setup() });
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    },
  });
}

/** A question's card: its number (a tick once answered), its question, and what answers it. Dimmed while it waits for the one before. */
function Ask({ n, done, title, waiting, children }: { n: number; done: boolean; title: string; waiting?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={cx("rounded-card border border-line bg-panel px-gutter py-4 shadow-card", waiting && "pointer-events-none opacity-35")}>
      <h2 className="flex items-center gap-2.5 text-title font-bold text-ink-strong">
        <span className={cx("grid h-[22px] w-[22px] place-items-center rounded-full text-xs", done ? "bg-good text-ground" : "bg-raised text-ink-2")}>{done ? <Check size={13} strokeWidth={3} /> : n}</span>
        {title}
      </h2>
      <div className="mt-3 ml-8 flex flex-col gap-2.5 text-ink-2">{children}</div>
    </section>
  );
}

/** One answer of a few, picked or not. */
function Choice({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cx("rounded-control border px-3.5 py-2 font-bold", on ? "border-accent bg-accent-wash text-ink-strong" : "border-line-strong text-ink hover:bg-hover")}>
      {children}
    </button>
  );
}

/**
 * What becomes of Afflatus's node pack: written into ComfyUI's custom_nodes by itself when ComfyUI runs on this machine
 * (its folder found); on this machine with its folder not found, its folder to set; else put in by hand from Settings ›
 * ComfyUI (a ComfyUI on another computer). `local` is the server's word (a probe's, or the settings' for a machine added,
 * Test pressed or not); unknown, it is said as another computer's.
 */
const packSaid = (dir: string | null | undefined, local?: boolean) =>
  dir
    ? "Afflatus puts its node pack in it by itself (loaded at ComfyUI's next start)."
    : local
      ? "On this PC, but its folder was not found: set it in Settings › ComfyUI (Folder on this computer) and Afflatus writes its node pack in."
      : "On another computer: Afflatus cannot write its node pack there; Settings › ComfyUI has it to put in by hand.";

/** A machine as found: its version, its GPU, its address. */
const foundSaid = (p: ComfyProbe) => (
  <>
    <b className="text-ink-strong">ComfyUI{p.version ? ` ${p.version}` : ""}</b>
    {p.device && <Chip>{shortGpu(p.device)}</Chip>}
    <span className="font-mono text-xs">{hostOf(p.url)}</span>
    {p.locked && <Chip tone="warn" tip="Its Afflatus node pack refuses calls without its token: once it is added, paste the token in Settings › ComfyUI.">locked</Chip>}
  </>
);

export function FirstLaunch() {
  const settings = useSettings();
  const save = useSave();
  const sayFailed = useSayFailed({ id: "first-launch" });
  const find = useQuery({ queryKey: ["first-launch", "find"], queryFn: () => api.findComfy(), staleTime: Infinity, retry: false });
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: () => api.health(), staleTime: Infinity });
  const ffmpeg = health.data?.checks.find((c) => c.id === "ffmpeg");
  const own = (settings.data?.machines ?? []).filter((m) => !m.rented);
  const [comfy, setComfy] = useState<Comfy>(own.length ? "added" : "looking");
  const [rent, setRent] = useState<"ask" | "yes" | "no">(settings.data?.hasRunpodKey ? "yes" : "ask");
  const [url, setUrl] = useState("http://127.0.0.1:8188");
  const [probe, setProbe] = useState<ComfyProbe | null>(null);

  // what the usual addresses answered: found, or the question asked
  useEffect(() => {
    if (comfy !== "looking" || find.isPending) return;
    const found = find.data?.found;
    if (found) setUrl(found.url);
    setComfy(found ? "found" : "have");
    if (!found && find.data?.tried[0]) setUrl(find.data.tried[0]);
  }, [comfy, find.isPending, find.data]);

  const test = useMutation({ mutationFn: (at: string) => api.probeComfy(at), onSuccess: setProbe });
  const add = (at: string) => save.mutate({ comfyUrl: at }, { onSuccess: () => setComfy("added"), onError: sayFailed("Your ComfyUI was not added") });
  // rented only: a ComfyUI of the user's own added before (Change) is taken out, the pods kept. Asked first: its token and
  // its families' switches go with it, and the page cannot put them back
  const none = async () => {
    if (own.length) {
      const names = own.map((m) => m.name || hostOf(m.url)).join(", ");
      const ok = await ask({ title: "Render on rented GPUs only?", text: `${own.length > 1 ? "Your ComfyUIs" : "Your ComfyUI"} (${names}) ${own.length > 1 ? "are" : "is"} taken out of Afflatus, with ${own.length > 1 ? "their" : "its"} settings. The pods stay.`, yes: own.length > 1 ? "Take them out" : "Take it out" });
      if (!ok) return;
      save.mutate({ machines: (settings.data?.machines ?? []).filter((m) => m.rented) as Settings["machines"] }, { onError: sayFailed("Your ComfyUI was not taken out") });
    }
    setComfy("none");
    setRent("yes");
  };

  const first = own[0];
  const answered = comfy === "added" || comfy === "none" || comfy === "install";
  const hasKey = Boolean(settings.data?.hasRunpodKey);
  const rentsOn = hasKey || rent === "yes";
  const where = [comfy === "added" ? "your ComfyUI" : null, rent === "yes" && hasKey ? "RunPod" : null].filter(Boolean).join(" and ");
  const caps = settings.data?.rentCaps ?? { day: 0, month: 0 };
  // queued as in Settings › Rented GPUs: a second cap saved before the first answers never sets the first one back
  const capsSave = useCapsSave(caps);
  // done: the settings say so, and the Studio takes its place (App.tsx useFirstLaunch). A cap still saving is waited for
  // first; refused, the page stays, its note under the boxes (a cap is money: never left unsaid)
  const end = async () => {
    if (!(await capsSave.settled())) return;
    save.mutate({ firstLaunch: "done" }, { onError: sayFailed("The first launch was not closed") });
  };

  return (
    <main aria-label="Where you render" className="relative flex grow justify-center overflow-y-auto">
      <Button tone="quiet" className="absolute top-5 right-7 bg-transparent text-ink-2" onClick={() => void end()}>Skip</Button>
      <div className="flex w-[680px] max-w-full flex-col gap-4 px-6 py-10">
        <div>
          <h1 className="text-display font-bold text-ink-strong">Where you render</h1>
          <p className="mt-1 text-title text-ink-2">Afflatus sends its jobs to ComfyUI: yours, rented GPUs, or both. All of it is in Settings later.</p>
        </div>

        {/* no ffmpeg that passes the start-up check: one line, and the way to one (ffmpegCheck.ts) */}
        {ffmpeg && !ffmpeg.ok && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-raised px-3.5 py-3">
            <span className="text-ink">ffmpeg {ffmpeg.detail}: trims, joins and exports need it.</span>
            <GetFfmpeg check={ffmpeg} here={health.data?.here} />
          </div>
        )}

        <Ask n={1} done={comfy === "added" || comfy === "none"} title="Your ComfyUI">
          {comfy === "looking" && <span>Looking for ComfyUI at 127.0.0.1:8188 and :8000…</span>}
          {comfy === "found" && find.data?.found && (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-raised px-3.5 py-3 text-ink">
                <span className="flex items-center gap-1.5 font-semibold text-good"><span className="h-[7px] w-[7px] rounded-full bg-good" />Found</span>
                {foundSaid(find.data.found)}
                <span className="grow" />
                <Button tone="primary" size="sm" disabled={save.isPending} onClick={() => add(find.data!.found!.url)}>Render on it</Button>
                <Button tone="quiet" size="sm" className="bg-transparent text-ink-2" onClick={() => setComfy("have")}>Not this one</Button>
              </div>
              <span className="text-ink-3">{find.data.found.locked ? "It is locked by an Afflatus node pack: once added, paste its token in Settings › ComfyUI." : packSaid(find.data.found.dir, find.data.found.local)}</span>
            </>
          )}
          {(comfy === "have" || comfy === "install") && (
            <>
              <span>{find.data?.found ? "Another ComfyUI, or none?" : <>Nothing answers at <span className="font-mono text-xs">{(find.data?.tried ?? ["http://127.0.0.1:8188", "http://127.0.0.1:8000"]).map(hostOf).join(" or ")}</span>. Do you have ComfyUI installed?</>}</span>
              <div className="flex flex-wrap gap-2">
                <Choice on={comfy === "have"} onClick={() => setComfy("have")}>Yes</Choice>
                <Choice on={comfy === "install"} onClick={() => setComfy("install")}>Not yet: I want to render on this PC</Choice>
                <Choice on={false} onClick={() => void none()}>No: rented GPUs only</Choice>
              </div>
            </>
          )}
          {comfy === "have" && (
            <>
              <div className="flex items-center gap-2">
                <input aria-label="ComfyUI address" value={url} onChange={(e) => { setUrl(e.target.value); setProbe(null); }} spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
                <Button disabled={test.isPending || !url.trim()} onClick={() => test.mutate(url.trim())}>{test.isPending ? "Testing…" : "Test"}</Button>
                <Button tone="primary" disabled={save.isPending || !url.trim()} onClick={() => add(url.trim())}>Add it</Button>
              </div>
              <span className="text-ink-3">
                {probe?.online ? <span className="mr-1 inline-flex items-center gap-2 text-ink">{foundSaid(probe)} ·</span> : probe ? <span className={cx("mr-1", probe.locked ? "text-warn-ink" : "text-attention-ink")}>{probe.locked ? "Locked against Afflatus: add it, then paste its token" : "Not answering"} ·</span> : null}
                Offline is fine: add it now, jobs wait until it answers. Started with <span className="font-mono">--listen</span> on another PC? Its address, port included.
              </span>
            </>
          )}
          {comfy === "install" && (
            <>
              <div className="flex flex-col gap-1.5">
                {INSTALLS.map((i) => (
                  <a key={i.name} href={i.href} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-control bg-raised px-3.5 py-2.5 text-ink hover:bg-hover">
                    <b className="text-ink-strong">{i.name}</b> {i.what}
                    <span className="ml-auto flex items-center gap-1.5 text-ink-3">{i.site} <ExternalLink size={13} /></span>
                  </a>
                ))}
              </div>
              <span className="text-ink-3">
                On this PC, Afflatus puts its node pack in by itself once it is added. Start ComfyUI, then{" "}
                <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => { void find.refetch(); setComfy("looking"); }}>Look again</button>, or add it later in Settings › ComfyUI.
              </span>
            </>
          )}
          {comfy === "added" && first && (
            <div className="flex items-center gap-2.5 text-ink">
              {probe?.online || find.data?.found?.url === first.url ? foundSaid(probe?.online ? probe : find.data!.found!) : <span className="font-mono text-xs">{hostOf(first.url)}</span>}
              <button type="button" className="ml-auto font-semibold text-ink-3 underline underline-offset-2" onClick={() => setComfy("have")}>Change</button>
            </div>
          )}
          {comfy === "added" && first && <span className="text-ink-3">{settings.data?.comfyDir ? `Its node pack is written into its custom_nodes folder (${settings.data.comfyDir}): ComfyUI loads it at its next start.` : packSaid(null, first.local)}</span>}
          {comfy === "none" && (
            <div className="flex items-center gap-2.5 text-ink">
              None: rented GPUs only
              <button type="button" className="ml-auto font-semibold text-ink-3 underline underline-offset-2" onClick={() => setComfy("have")}>Change</button>
            </div>
          )}
        </Ask>

        <Ask n={2} done={hasKey} title={comfy === "none" ? "Rented GPUs" : "Render on rented GPUs too?"} waiting={!answered}>
          {comfy !== "none" && (
            <div className="flex flex-wrap gap-2">
              <Choice on={rent === "yes"} onClick={() => setRent("yes")}>Yes, on RunPod</Choice>
              <Choice on={rent === "no"} onClick={() => setRent("no")}>Not now</Choice>
            </div>
          )}
          {rentsOn && rent !== "no" && (
            <>
              <div className="flex items-center gap-2">
                <SecretField id="first-runpod-key" label="RunPod API key" saved={hasKey} placeholder="Your RunPod API key" valid={(key) => key.length >= 10} busy={save.isPending}
                  onSave={(runpodKey) => save.mutateAsync({ runpodKey }).catch((err: Error) => { sayFailed("The RunPod key was not saved")(err); throw err; })} />
              </div>
              <span className="text-ink-3">
                {hasKey ? "Key set · " : "Your RunPod API key · "}
                <a href="https://www.runpod.io/console/user/settings" target="_blank" rel="noreferrer" className="font-bold text-accent hover:underline">make one on RunPod <ExternalLink size={12} className="inline" /></a> · kept in Afflatus, never shown again
              </span>
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-ink">Caps</span>
                <CapBox key={`day-${capsSave.resets.day}`} label="a day" value={caps.day} help={CAP_DAY_WHY} onSave={(day) => capsSave.change("day", day)} />
                <CapBox key={`month-${capsSave.resets.month}`} label="a month" value={caps.month} help={CAP_MONTH_WHY} onSave={(month) => capsSave.change("month", month)} />
              </div>
              {capsSave.notes.map((n) => <ErrorNote key={n.key}>{n.text}</ErrorNote>)}
              {/* where Deploy a GPU really is: the Queue offers it only while no machine is added, the status bar always (its
                  machines' pill once one is), Settings › Rented GPUs and the command bar too */}
              <span className="text-ink-3">Nothing deploys by itself: Deploy a GPU… is in the status bar at the foot of the screen, in Settings › Rented GPUs and in the command bar.</span>
            </>
          )}
        </Ask>

        {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
        {answered && (
          <div className="mt-1 flex items-center gap-3">
            <span className="grow text-ink-3">
              Renders on: <b className="text-ink">{where || "nothing yet: jobs wait until a machine is added"}</b>.{settings.data?.allFamilies && " Every family is on: what is not here is listed greyed, and comes when a job needs it."}
            </span>
            <Button tone="primary" disabled={save.isPending} onClick={() => void end()}>Done</Button>
          </div>
        )}
      </div>
    </main>
  );
}
