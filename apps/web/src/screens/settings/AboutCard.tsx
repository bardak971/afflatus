import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSetup } from "../../data";
import { sourceOf } from "../../format";
import { Button, cx, ErrorNote } from "../../ui";

/** The app itself: its version, where it runs, what it talks to. */
export function AboutCard() {
  const client = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), staleTime: Infinity });
  const recheck = useMutation({ mutationFn: () => api.checkHealth(), onSuccess: (h) => client.setQueryData(["health"], h) });
  const setup = useSetup();
  const comfy = setup.data?.comfy;
  const checks = health.data?.checks ?? [];
  return (
    <section id="about" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">About</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ink-2">
        <dt>Afflatus</dt><dd className="text-ink">{health.data ? `version ${health.data.version}` : "…"}</dd>
        <dt>Database</dt><dd className="text-ink">{health.data?.database ?? "…"}</dd>
        <dt>ComfyUI</dt><dd className="text-ink">{comfy?.online ? `${comfy.version} · ${comfy.nodes} node types · ${comfy.device}` : comfy ? "not answering" : "…"}</dd>
        <dt>License</dt><dd className="text-ink">AGPL-3.0</dd>
        {/* the AGPL's offer of the source: the code of the release that runs, not whatever the main branch holds now */}
        <dt>Source</dt><dd><a className="font-semibold text-ink underline" href={sourceOf(health.data?.version)} target="_blank" rel="noreferrer">{sourceOf(health.data?.version).replace(/^https:\/\//, "")}</a></dd>
      </dl>
      <h3 className="mt-2 font-bold">On this computer</h3>
      <div className="text-ink-2">What Afflatus needs where it runs, checked when it started{health.data?.checkedAt ? ` (${new Date(health.data.checkedAt).toLocaleTimeString()})` : ""}. ComfyUI is checked on its own tab.</div>
      <div className="flex flex-col gap-1.5">
        {checks.map((c) => (
          <div key={c.id} className={cx("flex flex-col gap-0.5 rounded-lg border px-3 py-2", c.ok ? "border-line" : "border-warn bg-warn-wash")}>
            <div className="flex items-center gap-2">
              <span className={cx("font-semibold", c.ok ? "text-good" : "text-warn-ink")}>{c.ok ? "✓" : "✕"}</span>
              <span className="font-semibold">{c.label}</span>
              <span className="min-w-0 truncate text-ink-2">{c.detail}</span>
            </div>
            {!c.ok && <div className="text-xs text-ink-2">{c.without} {c.fix}</div>}
          </div>
        ))}
        {health.isSuccess && !checks.length && <div className="text-xs text-ink-3">Not checked yet: the server started before these checks existed.</div>}
      </div>
      <div><Button size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending}>{recheck.isPending ? "Checking…" : checks.length ? "Check again" : "Check now"}</Button></div>
      {recheck.isError && <ErrorNote>{recheck.error.message}</ErrorNote>}
      <div className="text-xs text-ink-3">Afflatus runs in front of your own ComfyUI. Nothing leaves your computer unless you ask for a download or a lookup.</div>
    </section>
  );
}
