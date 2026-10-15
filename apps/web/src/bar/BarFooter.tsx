import type { Settings } from "../api";
import { cx } from "../ui";
import { Keys } from "../Keys";

/** The modes the footer lists, by their first character, with the sheet's names for them; `"` and `#` start a render search's key. */
const FOOTER_MODES: Array<[string, string]> = [[">", "commands"], ['"', "prompt:"], ["#", "in:"], ["/", "settings"], ["=", "calc"], ["!", "queue"], ["?", "keys"]];
/**
 * The parts of the bar that are off until turned on, listed dimmed in the footer while they are off: a power user finds
 * the `@` mode (and `;` snippets in prompt boxes) there, and a click opens their row in Settings › Command bar.
 */
const OFF_PARTS: Array<["cast" | "snippets", string, string]> = [["cast", "@", "cast"], ["snippets", ";", "snippets"]];

/**
 * The bar's footer, in the sheet's notation and names: keycaps for the keys and what they do now, the mode characters
 * as caps with their names (a click starts that mode), or for a moment a word (a figure copied, why Enter did nothing).
 */
export function BarFooter({ verb, off, second, acting, preview, flash, bar, onMode, onTurnOn }: {
  /** What Enter does now, and why it cannot when it cannot. */
  verb: string;
  off: string | null;
  /** What Ctrl+Enter does now, when it does something. */
  second: string | null;
  acting: boolean;
  preview: boolean;
  flash: { text: string; bad?: boolean } | null;
  bar: Settings["bar"] | undefined;
  /** A mode's character clicked: the bar starts on it. */
  onMode(c: string): void;
  /** A part that is off clicked: its row in Settings. */
  onTurnOn(part: "cast" | "snippets"): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line bg-ground/40 px-[18px] py-2.5 text-xs whitespace-nowrap text-ink-2">
      <span className="flex items-center gap-1.5"><Keys keys="↑ ↓" /> move</span>
      <span className="flex min-w-0 items-center gap-1.5"><Keys keys="Enter" /> <span className="max-w-[260px] truncate">{verb}{off && <span className="text-ink-3">: {off}</span>}</span></span>
      {second && <span className="flex min-w-0 items-center gap-1.5"><Keys keys="Ctrl+Enter" /> <span className="max-w-[170px] truncate">{second}</span></span>}
      <span className="flex items-center gap-1.5"><Keys keys="Tab" /> {acting ? "back" : "actions"}</span>
      <span className="flex items-center gap-1.5"><Keys keys="Shift" /> preview{preview ? "" : " (off)"}</span>
      <span className="grow" />
      {flash ? (
        <span role="status" className={cx("font-semibold", flash.bad ? "text-warn-ink" : "text-good")}>{flash.text}</span>
      ) : (
        <span className="flex min-w-0 flex-wrap justify-end gap-x-2.5 gap-y-1 text-ink-3">
          {[...FOOTER_MODES, ...(bar?.cast ? [["@", "cast"]] : [])].map(([c, w]) => (
            <button key={c} type="button" tabIndex={-1} onClick={() => onMode(c!)} className="flex items-center gap-1 hover:text-ink">
              <Keys keys={c!} /> {w}
            </button>
          ))}
          {bar && OFF_PARTS.filter(([k]) => !bar[k]).map(([k, c, w]) => (
            <button
              key={k} type="button" tabIndex={-1}
              data-tip="Off. Click to turn it on in Settings › Command bar."
              onClick={() => onTurnOn(k)}
              className="flex items-center gap-1 opacity-55 hover:text-ink hover:opacity-100"
            >
              <Keys keys={c} /> {w} off
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
