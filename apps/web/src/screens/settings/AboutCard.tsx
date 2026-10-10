import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSetup } from "../../data";
import { sourceOf, UI_LOCALE } from "../../format";
import { Button, ErrorNote, Help } from "../../ui";
import { Block, Card, Row, Status } from "./Rows";
import { queryKeys } from "../../queryKeys";

/** The app itself: its version, where it runs, what it talks to. */
export function AboutCard() {
  const client = useQueryClient();
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: () => api.health(), staleTime: Infinity });
  const recheck = useMutation({ mutationFn: () => api.checkHealth(), onSuccess: (h) => client.setQueryData(queryKeys.health(), h) });
  const setup = useSetup();
  const comfy = setup.data?.comfy;
  const checks = health.data?.checks ?? [];
  const checked = health.data?.checkedAt ? new Date(health.data.checkedAt).toLocaleTimeString(UI_LOCALE) : null;
  return (
    <div className="flex flex-col gap-4">
      <Card
        id="about"
        title={<span className="flex items-center gap-1.5">About <Help title="About" text="Afflatus runs in front of your own ComfyUI. Nothing leaves your computer unless you ask for a download or a lookup." /></span>}
        status={health.data && <span className="font-mono text-xs text-ink-3">{/^\d/.test(health.data.version) ? `v${health.data.version}` : health.data.version}</span>}
      >
        <Row setting="about.version" label="Afflatus"><span className="font-mono text-xs">{health.data ? `version ${health.data.version}` : "…"}</span></Row>
        <Row label="Database"><span className="font-mono text-xs">{health.data?.database ?? "…"}</span></Row>
        <Row label="ComfyUI"><span className="truncate font-mono text-xs">{comfy?.online ? `${comfy.version} · ${comfy.nodes} node types · ${comfy.device}` : comfy ? "not answering" : "…"}</span></Row>
        <Row label="License"><span className="font-mono text-xs">AGPL-3.0</span></Row>
        {/* the AGPL's offer of the source: the code of the release that runs, not whatever the main branch holds now */}
        <Row label="Source"><a className="font-mono text-xs font-semibold text-ink underline" href={sourceOf(health.data?.version)} target="_blank" rel="noreferrer">{sourceOf(health.data?.version).replace(/^https:\/\//, "")}</a></Row>
      </Card>

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
  );
}
