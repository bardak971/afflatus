import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, type CostsView } from "../../api";
import { plural, usd } from "../../format";
import { queryKeys } from "../../queryKeys";
import { Failed } from "../../ui";
import { presetWindow } from "../queue/costsView";
import { ElectricityCard } from "./ElectricityCard";
import { CapsCard } from "./RentedCard";
import { Block, Card, Row } from "./Rows";
import { COLUMNS } from "./wide";

/** This PC's renders in a window, in the user's money (or in kWh without a price), from the Queue's Costs figures. */
function homeSaid(d: CostsView): string {
  const renders = d.home.reduce((n, h) => n + h.renders, 0);
  if (!renders) return "no render";
  const cost = d.home.reduce<number | null>((n, h) => (h.cost === null ? n : (n ?? 0) + h.cost), null);
  const wh = d.home.reduce((n, h) => n + h.wh, 0);
  const said = cost !== null ? `${d.kwh.currency}${cost.toFixed(2)}` : wh ? `${(wh / 1000).toFixed(2)} kWh` : "power not read";
  return `${said} · ${plural(renders, "render")}`;
}

/** The start of today, here: the day cap's day. */
const today = () => {
  const d = new Date();
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), to: d.getTime() };
};

/**
 * Costs so far: this month and today, this PC's electricity and the rented GPUs' bill, as Queue › Costs reads them (the
 * same figures, its Month window shared); the way there, where they are read in full.
 */
function CostsSoFar() {
  // the Month window under the key the Queue's Costs tab gives it: whichever opens first, the other has it at once
  const month = useQuery({ queryKey: queryKeys.costs.of("Month"), queryFn: ({ signal }) => api.costs(presetWindow("Month"), { signal }), staleTime: 60_000 });
  const day = useQuery({ queryKey: queryKeys.costs.of("settings-today"), queryFn: ({ signal }) => api.costs(today(), { signal }), staleTime: 60_000 });
  const rented = Boolean(month.data?.runpod);
  return (
    <Card setting="costs.now" title="Costs so far" status={<Link href="/queue?view=costs" className="text-body font-semibold text-ink-2 hover:text-ink">Open Queue › Costs</Link>}>
      <Row label="This month">
        <span className="grow text-xs text-ink-2">{month.data ? <>this PC <span className="font-mono text-ink">{homeSaid(month.data)}</span></> : "…"}</span>
        {rented && <span className="text-xs text-ink-2">rented <span className="font-mono text-ink">{usd(month.data!.month, true)}</span></span>}
      </Row>
      <Row label="Today">
        <span className="grow text-xs text-ink-2">{day.data ? <>this PC <span className="font-mono text-ink">{homeSaid(day.data)}</span></> : "…"}</span>
        {rented && day.data && <span className="text-xs text-ink-2">rented <span className="font-mono text-ink">{usd(day.data.today.usd, true)}</span></span>}
      </Row>
      {(month.isError || day.isError) && <Block><Failed what="The costs could not be read" error={month.error ?? day.error} /></Block>}
    </Card>
  );
}

/**
 * Settings › Costs (card #168): what money is set against, in one place. The electricity's price and the spending caps on
 * the left (the price left the ComfyUI tab, the caps the RunPod account's card); this month's figures on the right, with
 * the way to Queue › Costs.
 */
export function CostsTab() {
  return (
    <div className={COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4"><ElectricityCard /><CapsCard /></div>
      <div className="flex min-w-0 flex-col gap-4"><CostsSoFar /></div>
    </div>
  );
}
