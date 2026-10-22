import type { NotifyKind } from "./api";
import { allowNotifications, useNotify } from "./store";
import { Toggle } from "./ui";

/** The Queue's notification switch: the same tick as Settings › Interface › Notifications, in its Browser column. */

const LABELS: Partial<Record<NotifyKind, string>> = { queueEmpty: "Notify when the queue is empty", renderDone: "Notify when a render finishes" };

/**
 * One kind's browser switch: turned on, it asks the browser for the right first. `onRefused`: whether the browser said no.
 * `bare`: the switch alone (a narrow header), its words in its tip.
 */
export function NotifyToggle({ kind, onRefused, bare }: { kind: NotifyKind; onRefused(refused: boolean): void; bare?: boolean }) {
  const notify = useNotify();
  const set = async (on: boolean) => {
    if (on && !(await allowNotifications())) return onRefused(true);
    onRefused(false);
    notify.set({ browser: { [kind]: on } });
  };
  const label = LABELS[kind] ?? kind;
  return <Toggle on={Boolean(notify.browser[kind])} onChange={(on) => void set(on)} label={label} bare={bare} tip={bare ? label : undefined} />;
}

/** What the switches do, behind a "?" beside them. */
export const NOTIFY_HELP = "A notification from your browser, while an Afflatus tab is open in it (one tab says it, however many are open). Set per browser. Telegram and Discord: Settings › Interface › Notifications.";
/** Why one did not turn on: said in a few words, the way out behind a "?". */
export const NOTIFY_REFUSED = { said: "Blocked by the browser", help: "Your browser does not allow notifications from this page. Allow them in its site settings, next to the address." };
