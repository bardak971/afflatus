import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SettingsPatch, type UpdatesView } from "../../api";
import { useSetup } from "../../data";
import { dayOf, plural, size, sourceOf, UI_LOCALE, when } from "../../format";
import { useCopied } from "../../hooks";
import { Progress } from "../../progress/Progress";
import { Button, cx, ErrorNote, Help, Toggle } from "../../ui";
import { aboutState, askGoBack, followRestart, newsOf, stepsOf, useUpdates, useUpdatesSeen, versionNote } from "../../updates";
import { Block, Card, Row, Status } from "./Rows";
import { queryKeys } from "../../queryKeys";
import { COLUMNS } from "./wide";

/** The app itself: its version, its updates, where it runs, what it talks to. */
export function AboutCard() {
  const client = useQueryClient();
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: () => api.health(), staleTime: Infinity });
  const recheck = useMutation({ mutationFn: () => api.checkHealth(), onSuccess: (h) => client.setQueryData(queryKeys.health(), h) });
  const updates = useUpdates();
  const setup = useSetup();
  const comfy = setup.data?.comfy;
  const checks = health.data?.checks ?? [];
  const checked = health.data?.checkedAt ? new Date(health.data.checkedAt).toLocaleTimeString(UI_LOCALE) : null;
  const v = updates.data;
  const note = v ? versionNote(v) : null;
  // the rail's dot goes once this card has been seen with the news on it, whether or not the dot was shown for it
  const seen = useUpdatesSeen((s) => s.seen);
  const see = useUpdatesSeen((s) => s.see);
  const news = newsOf(v, seen, true);
  useEffect(() => {
    if (news) see(news);
  }, [news, see]);
  const version = health.data?.version ?? v?.version;
  return (
    // two columns in a wide window, as the other tabs: the version on the left, the checks on the right
    <div className={COLUMNS}>
      <div className="flex flex-col gap-4">
        <Card
          id="about"
          title={<span className="flex items-center gap-1.5">About <Help title="About" text="Afflatus runs in front of your own ComfyUI. Nothing leaves your computer unless you ask for a download or a lookup." /></span>}
          status={version && <span className="font-mono text-xs text-ink-3">{/^\d/.test(version) ? `v${version}` : version}{v?.install === "docker" ? " · docker" : ""}</span>}
        >
          <Row setting="about.version" label="Afflatus">
            <span className="font-mono text-xs">{health.data ? `version ${health.data.version}` : "…"}</span>
            {note && <Status ok={note.good}>{note.text}</Status>}
          </Row>
          {v && <UpdatesPart v={v} startupUnchecked={health.isSuccess && !checks.length} />}
          <Row label="Database"><span className="font-mono text-xs">{health.data?.database ?? "…"}</span></Row>
          <Row label="ComfyUI"><span className="truncate font-mono text-xs">{comfy?.online ? `${comfy.version} · ${comfy.nodes} node types · ${comfy.device}` : comfy ? "not answering" : "…"}</span></Row>
          <Row label="License"><span className="font-mono text-xs">AGPL-3.0</span></Row>
          {/* the AGPL's offer of the source: the code of the release that runs, not whatever the main branch holds now */}
          <Row label="Source"><a className="font-mono text-xs font-semibold text-ink underline" href={sourceOf(health.data?.version)} target="_blank" rel="noreferrer">{sourceOf(health.data?.version).replace(/^https:\/\//, "")}</a></Row>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <Card
          setting="about.checks"
          title={<span className="flex items-center gap-1.5">On this computer <Help title="On this computer" text={`What Afflatus needs where it runs, checked when it started${checked ? ` (${checked})` : ""}. ComfyUI is checked on its own tab.`} /></span>}
          status={<Button size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending}>{recheck.isPending ? "Checking…" : checks.length ? "Check again" : "Check now"}</Button>}
        >
          {checks.map((c) => (
            <Row key={c.id} label={c.label} tone={c.ok ? undefined : "warn"} help={c.ok ? undefined : `${c.without} ${c.fix}`}>
              <span className="min-w-0 truncate font-mono text-xs text-ink-2">{c.detail}</span>
              <Status ok={c.ok}>{c.ok ? "OK" : "Failed"}</Status>
            </Row>
          ))}
          {health.isSuccess && !checks.length && <Block className="text-xs text-ink-3">Not checked yet: the server started before these checks existed.</Block>}
          {recheck.isError && <Block><ErrorNote>{recheck.error.message}</ErrorNote></Block>}
        </Card>
      </div>
    </div>
  );
}

/** A request about the updates (Check now, Update, Not now, Go back): its answer is the new view, which may say the server restarts. */
function useUpdatesAction(run: () => Promise<UpdatesView>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (view) => {
      client.setQueryData(queryKeys.updates(), view);
      followRestart(view.version, view.flow);
    },
  });
}

/** A block of the Updates part, washed in the accent when it is news, in warn when something did not go through. */
function Panel({ tone, children }: { tone?: "news" | "warn"; children: ReactNode }) {
  return <Block className={cx("gap-2.5 py-3.5", tone === "news" && "bg-accent-wash/60", tone === "warn" && "bg-warn-wash/60")}>{children}</Block>;
}

/** A command to run by hand (Docker, a checkout), with its Copy button. */
function Command({ text }: { text: string }) {
  const { copied, copy } = useCopied();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-ground px-2.5 py-1.5">
      <code className="min-w-0 grow truncate font-mono text-xs">{text}</code>
      <Button size="sm" onClick={() => copy(text)}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

/** The release's first lines and its page: the text is the release's own. */
function Notes({ v }: { v: UpdatesView }) {
  const r = v.latest!;
  return (
    <>
      {r.highlights.length > 0 && (
        <ul className="m-0 list-disc pl-[18px] text-body leading-relaxed text-ink-2">
          {r.highlights.map((h) => <li key={h}>{h}</li>)}
        </ul>
      )}
      {r.url && <a className="self-start text-body font-semibold text-accent underline" href={r.url} target="_blank" rel="noreferrer">All the release notes</a>}
    </>
  );
}

/**
 * The Updates part of About, in the states of a release's life (updates.ts aboutState): up to date, a new version out, an
 * update waiting for the queue, under way, failed; Docker and a checkout told their command; another computer told where
 * to press. Then the previous version kept to go back to, the last check, and the switch. `startupUnchecked`: the start-up
 * checks below never ran, so their card shows a "Check now" too; this one then says what it checks, so that the page
 * does not carry two buttons of the same name.
 */
function UpdatesPart({ v, startupUnchecked }: { v: UpdatesView; startupUnchecked: boolean }) {
  const client = useQueryClient();
  const pressedCheck = useUpdatesSeen((s) => s.ask);
  // Check now pressed: what it finds is said even with the daily checks off
  const check = useUpdatesAction(() => {
    pressedCheck();
    return api.checkUpdates();
  });
  const update = useUpdatesAction(api.startUpdate);
  const cancel = useUpdatesAction(api.cancelUpdate);
  const back = useUpdatesAction(api.goBack);
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings() });
      void client.invalidateQueries({ queryKey: queryKeys.updates() });
    },
  });
  const state = aboutState(v);
  const latest = v.latest?.version ?? "";
  // Go back refused before its question (a rented GPU runs, a hunt is on), said where the other refusals are
  const [refused, setRefused] = useState<Error | null>(null);
  const failed = refused ?? [check, update, cancel, back, save].find((m) => m.isError)?.error;
  const goBack = async () => {
    setRefused(null);
    const yes = await askGoBack(v.previous!.version).catch((err: Error) => (setRefused(err), false));
    if (yes) back.mutate();
  };
  return (
    <>
      {state === "available" && (
        <Panel tone="news">
          <div className="flex items-baseline gap-2"><span className="font-bold">Afflatus {latest} is out</span><span className="text-xs text-ink-2">you have {v.version}</span></div>
          <Notes v={v} />
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="primary" size="sm" disabled={!v.canUpdate || update.isPending} onClick={() => update.mutate()}>Update to {latest}</Button>
            <span className="text-xs text-ink-2">{v.cannot ?? "Afflatus restarts; your library stays as it is"}</span>
          </div>
        </Panel>
      )}
      {state === "elsewhere" && (
        <Panel>
          <span className="font-bold">Afflatus {latest} is out</span>
          <Notes v={v} />
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="primary" size="sm" disabled>Update to {latest}</Button>
            <span className="text-xs text-ink-2">only on the computer Afflatus runs on</span>
          </div>
        </Panel>
      )}
      {state === "docker" && (
        <Panel tone="news">
          <span className="font-bold">Afflatus {latest} is out</span>
          <Notes v={v} />
          <span className="text-body text-ink-2">Where your compose file is:</span>
          <Command text="docker compose pull && docker compose up -d" />
          <span className="text-xs text-ink-2">The data volume carries your library across.</span>
        </Panel>
      )}
      {state === "sources" && (
        <Panel>
          <span className="font-bold">{latest} is out on GitHub</span>
          <Notes v={v} />
          <Command text="git pull && pnpm install && pnpm build" />
          <span className="text-xs text-ink-2">Then start Afflatus again.</span>
        </Panel>
      )}
      {state === "waiting" && v.flow && (
        <Panel>
          <span className="font-bold">Updating to {v.flow.version} once the queue is done</span>
          <span className="text-body text-ink-2">{plural(v.flow.left, "render")} left. Nothing new starts meanwhile; the download is ready when they end.</span>
          <Bar done={1} tone="good" />
          <span className="text-xs text-ink-2">Downloaded and checked{v.flow.total ? ` · ${size(v.flow.total)}` : ""}</span>
          {v.here && <div><Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Not now</Button></div>}
        </Panel>
      )}
      {state === "updating" && v.flow && <Updating v={v} cancel={() => cancel.mutate()} cancelling={cancel.isPending} />}
      {state === "failed" && v.flow && (
        <Panel tone="warn">
          <span className="font-bold text-warn-ink">The update to {v.flow.version} did not go through</span>
          <span className="text-body leading-relaxed">{v.flow.error}</span>
          {v.here && <div><Button size="sm" disabled={update.isPending} onClick={() => update.mutate()}>Try again</Button></div>}
        </Panel>
      )}
      {v.fallback && (
        <Panel tone="warn">
          <span className="text-body">{v.fallback.version} did not start; back on {v.fallback.previous}.</span>
        </Panel>
      )}
      {v.last?.kind === "failed" && v.last.error && !v.fallback && (
        <Panel tone="warn">
          <span className="text-body">{v.last.error}</span>
        </Panel>
      )}
      {v.previous && (
        <Block className="gap-2 py-3">
          <div className="flex items-center gap-2.5 text-body">
            <span className="grow">Previous version</span>
            <span className="font-mono text-xs text-ink-2">{v.previous.version}, kept</span>
            <Button size="sm" disabled={!v.here || !v.previous.restoresLibrary || Boolean(v.flow && v.flow.phase !== "failed") || back.isPending} onClick={() => void goBack()}>Go back to {v.previous.version}…</Button>
          </div>
          <span className="text-xs leading-relaxed text-ink-3">
            {!v.previous.restoresLibrary
              ? "The copy of the library taken at the update is not there: going back is not offered."
              : v.here
                ? "Going back restores the library as it was at the update: what was made since stays in the folder, not in the list."
                : "Going back is done on the computer Afflatus runs on."}
          </span>
        </Block>
      )}
      {!v.flow && (
        <Row label="Updates" sub={v.checkError ? <span className="text-warn-ink">the last check got no answer: {v.checkError}</span> : undefined}>
          <span className="text-xs text-ink-3">{check.isPending ? "Asking GitHub…" : v.checkedAt ? `checked ${when(v.checkedAt)}` : "not checked yet"}</span>
          {v.here && <Button size="sm" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? "Checking…" : startupUnchecked ? "Check for updates" : "Check now"}</Button>}
        </Row>
      )}
      <Row setting="about.updates" label="Check for new versions" help="Once a day Afflatus asks GitHub for its latest release; nothing about you or your library is sent. A new version shows as a dot on Settings until you open About.">
        <Toggle bare on={v.checks} onChange={(on) => save.mutate({ afflatusUpdateChecks: on })} label="Check for new versions" />
      </Row>
      {v.last?.kind === "went-back" && v.last.to === v.version && <Block className="text-xs text-ink-3">Back on {v.last.to} since {dayOf(v.last.at)}: {v.last.from} was set aside.</Block>}
      {failed && <Block><ErrorNote>{failed.message}</ErrorNote></Block>}
    </>
  );
}

/** A thin bar: how far an update is. */
function Bar({ done, tone }: { done: number; tone: "good" | "accent" }) {
  return <Progress value={done} className="h-1.5" under="bg-line" tone={tone === "good" ? "bg-good" : "bg-accent"} label="Update" />;
}

/** An update under way: its steps, each done, now or to come, the bar, and Cancel until it switches. */
function Updating({ v, cancel, cancelling }: { v: UpdatesView; cancel(): void; cancelling: boolean }) {
  const flow = v.flow!;
  const { steps, done } = stepsOf(flow, v.version);
  const switching = flow.phase === "switching" || flow.phase === "restarting";
  return (
    <Panel>
      <span className="font-bold">Updating to {flow.version}</span>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-body">
        {steps.map((s) => (
          <li key={s.label} data-at={s.at} className={cx("flex items-center gap-2", s.at === "done" ? "text-good" : s.at === "now" ? "text-ink" : "text-ink-3")}>
            <span aria-hidden className="w-4 text-center font-bold">{s.at === "done" ? "✓" : s.at === "now" ? "•" : "·"}</span>
            <span className="grow">{s.label}</span>
            {s.note && <span className="font-mono text-xs text-ink-3">{s.note}</span>}
          </li>
        ))}
      </ol>
      <Bar done={done} tone="accent" />
      {v.here && <div><Button size="sm" disabled={switching || cancelling} onClick={cancel}>{switching ? "Switching over…" : "Cancel"}</Button></div>}
    </Panel>
  );
}
