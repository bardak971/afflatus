import type { BrowseVersion } from "../api";
import { ask } from "../Confirm";
import { dayOf } from "../format";

/**
 * A Civitai version sold for Buzz (Early Access, card #163): said on its card and in the version picker, and asked
 * before it is picked or downloaded, never hidden or held back (no filter-gated button). Civitai refuses its download,
 * whatever the key, until it is unlocked on its page.
 */

/** Its chip's words: "Early Access · until 5 Nov" while it ends some day, "Paid" for good. */
export const paidWords = (paid: NonNullable<BrowseVersion["paid"]>): string => (paid.until ? `Early Access · until ${dayOf(paid.until)}` : "Paid");

/** The plain explanation, behind the chip's "?" and the question's. */
export const PAID_HELP =
  "Civitai sells this version for Buzz, its points (Early Access): it refuses the download, even with your API key, until you unlock the version on its Civitai page. An Early Access version becomes free on its end date; a paid one stays paid. Another version of the model may be free.";

/** Asked before a paid version's file goes on (`verb`: Pick, Download): true to go ahead, at once for a free version. */
export function askPaid(v: Pick<BrowseVersion, "name" | "paid">, verb: "Pick" | "Download"): Promise<boolean> {
  if (!v.paid) return Promise.resolve(true);
  return ask({
    title: "This version is paid on Civitai",
    text: `${v.name} · ${paidWords(v.paid)}: Buzz needed, Civitai refuses its download until it is unlocked on its page. ${verb} anyway?`,
    yes: `${verb} anyway`,
    help: PAID_HELP,
  });
}
