import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, cx, fieldClass } from "../../ui";
import { Card, Row } from "./Rows";
import { SETTING_HELP } from "@afflatus/core";

/**
 * This PC's electricity: a kWh's price and the symbol of its money, which the Queue's Costs tab multiplies its renders'
 * GPU energy by (read from the node pack while they render). One form for the tab's dialog and the settings row.
 */
export function KwhForm({ onDone }: { onDone?(): void }) {
  const settings = useSettings();
  const client = useQueryClient();
  const saved = settings.data?.costs ?? { kwhPrice: null, currency: "€" };
  const [price, setPrice] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const failed = useSayFailed({ id: "costs-kwh", href: "/queue?view=costs", go: "Open Queue › Costs" });
  const save = useMutation({
    mutationFn: (costs: { kwhPrice: number | null; currency: string }) => api.saveSettings({ costs }),
    onSuccess: (s) => {
      client.setQueryData(queryKeys.settings(), s);
      setPrice(null);
      setCurrency(null);
      void client.invalidateQueries({ queryKey: queryKeys.costs.all() });
      onDone?.();
    },
    onError: failed("The price a kWh was not saved"),
  });
  const priceText = price ?? (saved.kwhPrice === null ? "" : String(saved.kwhPrice));
  const symbol = currency ?? saved.currency;
  const typed = priceText.trim() === "" ? null : Number(priceText.replace(",", ".").trim());
  const wrong = kwhWrong(typed, symbol);
  const wrongId = useId();
  const ok = wrong === null;
  const changed = price !== null || currency !== null;
  return (
    <form
      // right-aligned: the line of what is wrong, as wide as the row, does not push the fields to the left
      className="flex flex-wrap items-center justify-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) save.mutate({ kwhPrice: typed, currency: symbol.trim() });
      }}
    >
      <input
        aria-label="Currency symbol" aria-invalid={wrong?.field === "currency"} aria-describedby={wrong?.field === "currency" ? wrongId : undefined} value={symbol} maxLength={4} spellCheck={false} onChange={(e) => setCurrency(e.target.value)}
        data-tip="The symbol your price is in: €, $, £, CHF…" className={cx("h-8 w-14 px-2 text-center font-mono text-sm", fieldClass)}
      />
      <input
        aria-label="Price a kWh" value={priceText} inputMode="decimal" placeholder="0.25" spellCheck={false} onChange={(e) => setPrice(e.target.value)}
        aria-invalid={wrong?.field === "price"} aria-describedby={wrong?.field === "price" ? wrongId : undefined} className={cx("h-8 w-24 px-2 font-mono text-sm", fieldClass)}
      />
      <span className="text-xs text-ink-3">a kWh</span>
      <Button size="sm" tone={changed ? "primary" : "plain"} type="submit" data-tip={wrong?.says} disabled={!ok || save.isPending || (!changed && !onDone)}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      {/* what is wrong, in words under the fields: a red border alone and a dimmed Save do not say what to type */}
      {wrong && <span id={wrongId} role="alert" className="basis-full text-right text-xs text-warn-ink">{wrong.says}</span>}
    </form>
  );
}

/** What is wrong with a typed price and symbol, in a line to show under them; null when they can be saved. Empty is a price: none. */
export function kwhWrong(typed: number | null, symbol: string): { field: "price" | "currency"; says: string } | null {
  if (typed !== null && !Number.isFinite(typed)) return { field: "price", says: "Not a number: write the price as 0.25" };
  if (typed !== null && (typed < 0 || typed > 100)) return { field: "price", says: "A price a kWh is between 0 and 100" };
  if (!symbol.trim()) return { field: "currency", says: "Say the money's symbol: €, $, £, CHF…" };
  return null;
}

/** Settings › Costs (card #168: it was on the ComfyUI tab): the electricity row, where the settings search and the command bar's `/` find it. */
export function ElectricityCard() {
  return (
    <Card title="Electricity">
      <Row
        setting="costs.kwh" label="Price a kWh"
        help={SETTING_HELP.costs}
      >
        <KwhForm />
      </Row>
    </Card>
  );
}
