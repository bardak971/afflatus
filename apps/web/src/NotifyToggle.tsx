import { allowNotifications, useNotify } from "./store";
import { Toggle } from "./ui";

/** The notification switches, the same in Settings and in the Queue. */

type What = "whenEmpty" | "eachRender";
const LABELS: Record<What, string> = { whenEmpty: "Notify when the queue is empty", eachRender: "Notify when a render finishes" };

/** One notification switch: turned on, it asks the browser for the right first. `onRefused`: whether the browser said no. */
export function NotifyToggle({ what, onRefused }: { what: What; onRefused(refused: boolean): void }) {
  const notify = useNotify();
  const set = async (on: boolean) => {
    if (on && !(await allowNotifications())) return onRefused(true);
    onRefused(false);
    notify.set({ [what]: on });
  };
  return <Toggle on={notify[what]} onChange={(on) => void set(on)} label={LABELS[what]} />;
}

/** What the switches do, behind a "?" beside them. */
export const NOTIFY_HELP = "A notification from your browser, while an Afflatus tab is open in it (one tab says it, however many are open). Nothing leaves your computer. Set per browser.";
/** Why one did not turn on: said in a few words, the way out behind a "?". */
export const NOTIFY_REFUSED = { said: "Blocked by the browser", help: "Your browser does not allow notifications from this page. Allow them in its site settings, next to the address." };
