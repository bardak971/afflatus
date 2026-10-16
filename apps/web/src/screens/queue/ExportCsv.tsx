import { useState } from "react";
import { Download } from "lucide-react";
import { saveFromServer } from "../../download";
import { useSayFailed } from "../../sayFailed";
import { Button, Help } from "../../ui";

/** What the "?" beside it says: how the file is written, and how a spreadsheet in a language with a decimal comma opens it. */
const CSV_HELP =
  "A CSV of what this tab shows, every row. Comma-separated with a dot for decimals: Google Sheets, LibreOffice and Excel in English open it as is; Excel in French or another language using a comma for decimals: Data › From Text/CSV, comma as separator.";

/**
 * A Queue tab's "Export CSV": the server writes the file of the tab's window and filters (every row, not only those drawn:
 * the server's csvExports.ts), saved under the name it gives. Off while the window has nothing in it.
 */
export function ExportCsv({ path, fallbackName, disabled }: { path: string; fallbackName: string; disabled?: boolean }) {
  const failed = useSayFailed({ id: "queue", href: "/queue", go: "Open queue" });
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    saveFromServer(path, fallbackName).catch(failed("Could not export the CSV")).finally(() => setBusy(false));
  };
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button size="sm" tone="quiet" disabled={disabled || busy} onClick={save} data-tip={disabled ? "Nothing in this window" : undefined}>
        <Download size={14} />{busy ? "Exporting…" : "Export CSV"}
      </Button>
      <Help text={CSV_HELP} title="Export CSV" />
    </span>
  );
}
