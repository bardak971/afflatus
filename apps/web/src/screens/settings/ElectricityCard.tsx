import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings } from "../../data";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, cx, fieldClass } from "../../ui";
import { Card, Row } from "./Rows";

/**
 * This PC's electricity: a kWh's price and the symbol of its money, which the Queue's Costs tab multiplies its renders'
 * GPU energy by (read from the node pack while they render). One form for the tab's dialog and the settings row.
 */
export function KwhForm({ onDone, compact }: { onDone?(): void; compact?: boolean }) {
  const settings = useSettings();
  const client = useQueryClient();
  const saved = settings.data?.costs ?? { kwhPrice: null, currency: "€" };
  const [price, setPrice] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const failed = useSayFailed({ id: "costs-kwh", href: "/queue?view=costs", go: "Open Costs" });
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
  const ok = (typed === null || (Number.isFinite(typed) && typed >= 0 && typed <= 100)) && symbol.trim().length >= 1 && symbol.trim().length <= 4;
  const changed = price !== null || currency !== null;
  return (
    <form
      className={cx("flex flex-wrap items-center gap-2", compact && "justify-end")}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) save.mutate({ kwhPrice: typed, currency: symbol.trim() });
      }}
    >
      <input
        aria-label="Currency symbol" value={symbol} maxLength={4} spellCheck={false} onChange={(e) => setCurrency(e.target.value)}
        data-tip="The symbol your price is in: €, $, £, CHF…" className={cx("h-8 w-14 px-2 text-center font-mono text-sm", fieldClass)}
      />
      <input
        aria-label="Price a kWh" value={priceText} inputMode="decimal" placeholder="0.25" spellCheck={false} onChange={(e) => setPrice(e.target.value)}
        aria-invalid={!ok} className={cx("h-8 w-24 px-2 font-mono text-sm", fieldClass)}
      />
      <span className="text-xs text-ink-3">a kWh</span>
      <Button size="sm" tone={changed ? "primary" : "plain"} type="submit" disabled={!ok || save.isPending || (!changed && !onDone)}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/** Settings › ComfyUI: the electricity row, where the settings search and the command bar's `/` find it. */
export function ElectricityCard() {
  return (
    <Card title="Electricity">
      <Row
        setting="costs.kwh" label="Price a kWh"
        help="What a kWh costs you, in your own money. Queue › Costs multiplies it by the energy the GPU drew while each render ran on this PC (read by the Afflatus node pack on an NVIDIA GPU). Empty: the energy alone is shown. Rented GPUs are priced by the hour, not by this."
      >
        <KwhForm />
      </Row>
    </Card>
  );
}
