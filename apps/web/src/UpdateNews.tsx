import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useBanners } from "./store";
import { Button } from "./ui";
import { followRestart, securityNews, useRestarting, useUpdates, useUpdatesSeen } from "./updates";

/** A restart that takes longer than this is said, with a way to read the page again by hand. */
const LONG_MS = 60_000;

/**
 * What Afflatus's own updates put over every screen: the banner of a release that fixes a security issue (once per
 * version), and "Restarting…" while the server switches.
 */
export function UpdateNews() {
  const updates = useUpdates();
  const v = updates.data;
  const push = useBanners((s) => s.push);
  const closed = useUpdatesSeen((s) => s.security);
  const closeSecurity = useUpdatesSeen((s) => s.closeSecurity);
  const asked = useUpdatesSeen((s) => s.asked);
  const security = securityNews(v, asked);
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
  return <Restarting />;
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
