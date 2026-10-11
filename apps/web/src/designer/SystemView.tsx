import { useQuery } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";
import { api } from "../api";
import { Button, ErrorNote } from "../ui";
import { queryKeys } from "../queryKeys";
import { useCopied } from "../hooks";

/** The system prompt as the designer would be given it now, read-only, with a copy. It is fetched fresh each time it opens: it follows the form. */
export function SystemView({ body, onClose }: { body: Parameters<typeof api.designerSystem>[0]; onClose(): void }) {
  const key = JSON.stringify(body);
  const q = useQuery({ queryKey: queryKeys.designerSystem(key), queryFn: () => api.designerSystem(body), staleTime: 0 });
  const { copied, copy } = useCopied();
  return (
    <div className="flex min-h-0 grow flex-col border-b border-line">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-ink-2">
        <span className="grow">The system prompt for this form, as it is sent.{q.data ? ` ${q.data.system.split(/\s+/).length} words.${q.data.sees ? " The picture is sent with it." : ""}` : ""}</span>
        <Button size="sm" tone="quiet" disabled={!q.data} onClick={() => copy(q.data?.system ?? "")}>
          <Copy size={12} /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" tone="quiet" onClick={onClose}><X size={12} /> Close</Button>
      </div>
      {q.isError && <ErrorNote>{q.error.message}</ErrorNote>}
      <pre className="min-h-0 grow overflow-auto px-4 pb-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink">{q.data?.system ?? (q.isPending ? "…" : "")}</pre>
    </div>
  );
}
