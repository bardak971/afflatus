import { useState } from "react";
import { NotifyToggle, notifyNote } from "../../NotifyToggle";

/** What this browser tells you about. */
export function NotifyCard() {
  const [refused, setRefused] = useState(false);
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]">
      <h2 className="text-[15px] font-bold">Notifications</h2>
      <NotifyToggle what="eachRender" onRefused={setRefused} />
      <NotifyToggle what="whenEmpty" onRefused={setRefused} />
      <div className="text-xs text-ink-3">{notifyNote(refused)}</div>
    </section>
  );
}
