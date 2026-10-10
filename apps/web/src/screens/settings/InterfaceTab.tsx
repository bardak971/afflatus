import { useState } from "react";
import { allowNotifications, useCompareResult, useExplain, useHoverPlay, useNotify } from "../../store";
import { ThemeMode, ThemePickers } from "../../theme/Appearance";
import { Help, Toggle } from "../../ui";
import { Block, Card, Row } from "./Rows";

const BROWSER = "Set per browser, while an Afflatus tab is open in it (one tab says it, however many are open). Nothing leaves your computer.";

/** Settings › Interface: how Afflatus looks and behaves in this browser, and what it tells you about. */
export function InterfaceTab() {
  const explain = useExplain();
  const hover = useHoverPlay();
  const compare = useCompareResult();
  const notify = useNotify();
  const [refused, setRefused] = useState(false);
  // turned on, a notification switch asks the browser for the right first (as NotifyToggle in the Queue does)
  const setNotify = async (what: "whenEmpty" | "eachRender", on: boolean) => {
    if (on && !(await allowNotifications())) return setRefused(true);
    setRefused(false);
    notify.set({ [what]: on });
  };
  return (
    <div className="flex flex-col gap-4">
      <Card
        title={<span className="flex items-center gap-1.5">Appearance <Help title="Appearance" text="Kept in this browser, so that another screen can look another way. Studio is the app's own neutral grey; Catppuccin, Rosé Pine, Tokyo Night and Kanagawa use their authors' palettes." /></span>}
        status={<div className="w-64"><ThemeMode /></div>}
      >
        <Block setting="interface.theme interface.accent" className="gap-3.5 py-4"><ThemePickers /></Block>
        <Row setting="explain" label="Explain every setting in the forms" help="Off: the explanation of a setting sits behind the ? beside its name. On: it is written under each setting.">
          <Toggle bare on={explain.on} onChange={explain.set} label="Explain every setting in the forms" />
        </Row>
        <Row setting="hover.video" label="Play videos on hover" help="A video card plays, muted unless the next switch is on, while the mouse rests on it. Off: it shows its frame until you open it.">
          <Toggle bare on={hover.video} onChange={(video) => hover.set({ video })} label="Play videos when the mouse rests on a card" />
        </Row>
        <Row setting="hover.sound" label="Play sound on hover" help="The sound of a video playing on hover, and of a sound card. Off: videos play muted and sound cards stay silent until opened.">
          <Toggle bare on={hover.sound} onChange={(sound) => hover.set({ sound })} label="Play sound on hover" />
        </Row>
        <Row setting="compare.result" label="Compare opens on original vs result" help="On a pass's result (an upscale, a face detailer, a mirror), Compare (X) puts its source beside it; on a picture something was made from, the newest result. Off: Compare pins the item and the arrow keys bring the next one of the list.">
          <Toggle bare on={compare.on} onChange={compare.set} label="Compare opens on original vs result" />
        </Row>
      </Card>

      <Card title="Notifications" id="notifications">
        <Row setting="notify.each" label="Notify after each render" help={`A browser notification when a render finishes or fails. ${BROWSER}`}>
          <Toggle bare on={notify.eachRender} onChange={(on) => void setNotify("eachRender", on)} label="Notify when a render finishes" />
        </Row>
        <Row setting="notify.empty" label="Notify when the queue is empty" help={`A browser notification when everything that was waiting is done. ${BROWSER}`}>
          <Toggle bare on={notify.whenEmpty} onChange={(on) => void setNotify("whenEmpty", on)} label="Notify when the queue is empty" />
        </Row>
        {refused && (
          <Row tone="warn" label="Blocked by the browser" help="Allow notifications for this page in the browser's site settings, next to the address, then turn the switch on again.">
            <span className="text-xs text-warn-ink">allow them next to the address</span>
          </Row>
        )}
      </Card>
    </div>
  );
}
