import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderInput, RefreshCw } from "lucide-react";
import { api } from "./api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "./Dialog";
import { useBanners } from "./store";
import { Button, ErrorNote } from "./ui";
import { followRestart, useRestarting, useUpdates, useUpdatesSeen } from "./updates";
import { queryKeys } from "./queryKeys";

/** A restart that takes longer than this is said, with a way to read the page again by hand. */
const LONG_MS = 60_000;

/**
 * What Afflatus's own updates put over every screen: the banner of a release that fixes a security issue (once per
 * version), the 0.3 library's move offered on a fresh bundle, and "Restarting…" while the server switches.
 */
export function UpdateNews() {
  const updates = useUpdates();
  const v = updates.data;
  const push = useBanners((s) => s.push);
  const closed = useUpdatesSeen((s) => s.security);
  const closeSecurity = useUpdatesSeen((s) => s.closeSecurity);
  const security = v?.newer && v.latest?.security ? v.latest : null;
  useEffect(() => {
    if (!security || closed === security.version) return;
    const version = security.version;
    push({
      id: "updates:security",
      tone: "bad",
      title: `Afflatus ${version} fixes a security issue: update when you can`,
      text: security.security ?? undefined,
      href: "/settings/about",
      go: "Update…",
      onDismiss: () => closeSecurity(version),
    });
  }, [security, closed, push, closeSecurity]);
  // a view read while the server is restarting (a page opened, or read again, in that moment) says so too
  useEffect(() => {
    if (v) followRestart(v.version, v.flow);
  }, [v]);
  return (
    <>
      {v?.move && v.here && <MoveDialog from={v.move.from} version={v.move.version} />}
      <Restarting />
    </>
  );
}

/** The 0.3 library found beside this fresh bundle: brought over (moved, not copied), or left where it is. */
function MoveDialog({ from, version }: { from: string; version: string }) {
  const client = useQueryClient();
  const declined = useUpdatesSeen((s) => s.moveDeclined);
  const decline = useUpdatesSeen((s) => s.declineMove);
  const move = useMutation({
    mutationFn: api.moveLibrary,
    onSuccess: (view) => {
      client.setQueryData(queryKeys.updates(), view);
      followRestart(view.version, view.flow);
    },
  });
  if (declined === from || move.isSuccess) return null;
  return (
    <Dialog label={`Bring your library from Afflatus ${version}?`} onClose={() => decline(from)} className={DIALOG.replace("max-w-md", "max-w-lg")}>
      <DialogHead icon={<FolderInput size={15} />} title={`Bring your library from Afflatus ${version}?`} />
      <span className="text-[13px] text-ink-2">Found beside this one:</span>
      <code className="rounded-[10px] border border-line bg-ground px-3.5 py-3 font-mono text-xs break-all">{from}</code>
      <p className="m-0 text-[13px] leading-relaxed text-ink-2">
        It is moved, not copied: no second copy on your disk. Its settings, the Prompt kit and your linked folders come with it. The {version} folder can be deleted afterwards.
      </p>
      {move.isError && <ErrorNote>{move.error.message}</ErrorNote>}
      <DialogFoot>
        <Button onClick={() => decline(from)}>Start empty</Button>
        <Button tone="primary" disabled={move.isPending} onClick={() => move.mutate()}>{move.isPending ? "Bringing it over…" : "Bring it over"}</Button>
      </DialogFoot>
    </Dialog>
  );
}

/** "Restarting…" over the page while the server switches; the page reads itself again when it is back (live.ts). */
function Restarting() {
  const since = useRestarting((s) => s.since);
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (since === null) return;
    const t = setTimeout(() => setLong(true), Math.max(0, since + LONG_MS - Date.now()));
    return () => clearTimeout(t);
  }, [since]);
  if (since === null) return null;
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Restarting" className="fixed inset-0 z-[100] flex items-center justify-center bg-ground/90 p-8 motion-safe:animate-[peek-fade_100ms_ease-out]">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <RefreshCw size={22} className="animate-spin text-accent [animation-duration:1.6s] motion-reduce:animate-none" aria-hidden />
        <span className="text-base font-bold">Restarting…</span>
        <span className="text-[13px] text-ink-2">
          {long ? "Afflatus is taking longer than usual to come back: its console says why." : "Afflatus comes back by itself in a moment; this page reloads then."}
        </span>
        {long && <Button size="sm" onClick={() => location.reload()}>Reload</Button>}
      </div>
    </div>
  );
}
