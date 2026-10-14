import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { getOnPc, openFindModels } from "../../findModels/store";
import { queryKeys } from "../../queryKeys";
import { Button, cx, ErrorNote } from "../../ui";
import { Block, Card, Row } from "./Rows";

const WHY = "Every model file of this PC's ComfyUI is hashed once (its SHA-256: a fingerprint of its content, read from the file, a minute after Afflatus starts and when you press Hash now; paused while this PC renders). Civitai is then asked which version each one is, all in one request, and Hugging Face by the file's name, taken only when its file has the same SHA-256. A rented GPU then fetches each from that site, faster than this PC's upload and sparing its line; one no site has is sent from here.";

/**
 * Your models online: how far the hashing of this PC's model files is, and which site has each (Civitai, Hugging Face, or
 * none: sent from this PC to a pod). Find models, for this PC, from here too.
 */
export function ModelsOnlineCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.modelHashes(),
    queryFn: ({ signal }) => api.modelHashes({ signal }),
    // read again while it hashes, rarely otherwise
    refetchInterval: (q) => (q.state.data?.hashing ? 2_000 : 60_000),
  });
  const run = useMutation({ mutationFn: () => api.hashModels(), onSuccess: (s) => client.setQueryData(queryKeys.modelHashes(), s) });
  const s = status.data;
  const lookups = Boolean(settings.data?.civitaiLookups);
  const part = s && s.files ? s.hashed / s.files : 0;
  return (
    <Card title="Your models online" setting="models.online" help={WHY} status={<Button size="sm" disabled={!lookups} onClick={() => openFindModels({ what: "this PC", action: "Get on this PC", pc: true, add: async (files) => {
      await getOnPc(files);
      void client.invalidateQueries({ queryKey: queryKeys.downloads() });
    } })} data-tip={lookups ? "Civitai, Hugging Face and yours, to download onto this PC" : "Turn on Search Hugging Face and Civitai (Missing models) first"}>Find models…</Button>}>
      {s?.noFolder ? (
        <Block><span className="text-xs text-ink-2">No ComfyUI folder on this PC (Settings › ComfyUI): nothing to hash here.</span></Block>
      ) : s && (
        <>
          <Row label="Hashed">
            <span className="flex min-w-0 grow flex-col gap-1.5">
              <span className="text-[12.5px]">
                {!s.looked ? <span className="text-ink-2">Not looked at yet: a minute after Afflatus starts, or Hash now</span>
                  : !s.files ? <span className="text-ink-2">No model file in this PC's ComfyUI folders</span>
                  : <><span className="font-mono">{s.hashed} / {s.files}</span>{s.files > s.hashed ? <span className="text-ink-3"> · {s.files - s.hashed} not hashed yet</span> : <span className="text-good"> · all</span>}</>}
              </span>
              <span className="h-[5px] max-w-[320px] overflow-hidden rounded-[3px] bg-line-strong"><span className="block h-full rounded-[3px] bg-accent" style={{ width: `${part * 100}%` }} /></span>
              {s.hashing && <span className="truncate text-xs text-ink-3">{s.paused ? "waiting for this PC's render to end · " : ""}{s.hashing.file} · {Math.round((s.hashing.bytes / Math.max(1, s.hashing.total)) * 100)}%</span>}
            </span>
            <Button size="sm" onClick={() => run.mutate()} disabled={Boolean(s.hashing) || run.isPending}>Hash now</Button>
          </Row>
          <Row label="Where each is">
            {lookups ? (
              <span className="grid min-w-0 grow grid-cols-3 gap-2">
                <Count n={s.civitai} what="on Civitai" sub="matched by hash" />
                <Count n={s.huggingFace} what="on Hugging Face" sub="by name, checked by hash" />
                <Count n={s.nowhere} what="this PC only" sub="sent from here to a pod" warn />
              </span>
            ) : <span className="text-xs text-ink-2">Not asked: Search Hugging Face and Civitai is off (Missing models).</span>}
          </Row>
          {s.error && <Block><ErrorNote>{s.error}</ErrorNote></Block>}
        </>
      )}
      {status.isError && <Block><ErrorNote>{status.error.message}</ErrorNote></Block>}
    </Card>
  );
}

function Count({ n, what, sub, warn }: { n: number; what: string; sub: string; warn?: boolean }) {
  return (
    <span className="flex flex-col rounded-lg border border-line bg-raised/50 px-2.5 py-1.5">
      <span className={cx("text-lg font-bold", warn && n > 0 && "text-warn-ink")}>{n}</span>
      <span className="text-xs text-ink-2">{what}</span>
      <span className="text-[11px] text-ink-3">{sub}</span>
    </span>
  );
}

