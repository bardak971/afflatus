import { useState } from "react";
import { allowNotifications, useNotify } from "../../store";
import { Toggle } from "../../ui";

/** What this browser tells you about. */
export function NotifyCard() {
  const notify = useNotify();
  const [refused, setRefused] = useState(false);
  const set = async (patch: { whenEmpty?: boolean; eachRender?: boolean }) => {
    if (Object.values(patch).some(Boolean) && !(await allowNotifications())) return setRefused(true);
    setRefused(false);
    notify.set(patch);
  };
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Notifications</h2>
      <Toggle on={notify.eachRender} onChange={(on) => void set({ eachRender: on })} label="Notify when a render finishes" />
      <Toggle on={notify.whenEmpty} onChange={(on) => void set({ whenEmpty: on })} label="Notify when the queue is empty" />
      <div className="text-xs text-ink-3">
        {refused ? "Your browser does not allow notifications from this page. Allow them in its settings, next to the address." : "A notification from your browser, while a Afflatus tab is open in it. Nothing leaves your computer. This is set per browser."}
      </div>
    </section>
  );
}
