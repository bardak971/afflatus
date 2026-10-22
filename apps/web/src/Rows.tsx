import { createContext, useContext, type ReactNode } from "react";
import { Chip, cx, Help } from "./ui";

/**
 * The shapes of the settings-like screens (Settings, the Prompt kit's editors): a card of rows, each setting
 * one row (its name and ? on the left, its control on the right). What used to be a paragraph under a setting
 * is behind its ?: the page reads as a list of settings, not as a manual.
 */

/** A dense card (the Prompt kit's): a small upper-case head, narrower names; its rows read it from here. */
const Dense = createContext(false);

/**
 * A card: its title with what it says at a glance on the right, then its rows, a thin line between them.
 * `dense`: the Prompt kit's look, an 11px upper-case head and 150px names. `help`: what the card is for,
 * behind a ? right after its title (as a row's ? follows its name); `status` stays on the right.
 */
export function Card({ title, status, sub, help, dense, id, label, setting, children }: { title?: ReactNode; status?: ReactNode; /** A quiet line under the head, in it (a machine's facts). */ sub?: ReactNode; help?: string; dense?: boolean; id?: string; label?: string; setting?: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={label} data-setting={setting} className="overflow-hidden rounded-card border border-line bg-panel shadow-card">
      {title && (
        <div className={cx("flex flex-col gap-1.5 border-b border-line", dense ? "min-h-[42px] px-4 py-2" : "min-h-[48px] px-[18px] py-2.5", Boolean(sub) && "pb-3")}>
          <div className="flex min-h-[28px] items-center gap-2.5">
            <h2 className={cx("min-w-0", dense ? "text-meta font-bold tracking-label text-ink-3 uppercase" : "text-title font-bold")}>{title}</h2>
            {help && <Help text={help} title={typeof title === "string" ? title : label} className="-ml-1" />}
            <span className="grow" />
            {status}
          </div>
          {sub}
        </div>
      )}
      <Dense.Provider value={Boolean(dense)}>
        <div className="flex flex-col divide-y divide-line/60">{children}</div>
      </Dense.Provider>
    </section>
  );
}

/** A dot and a word for a card's head or a tab: green when all is well, warn when not. */
export function Status({ ok, children }: { ok: boolean; children?: ReactNode }) {
  return (
    <span className={cx("flex shrink-0 items-center gap-1.5 text-body font-semibold", ok ? "text-good" : "text-warn-ink")}>
      <span className={cx("h-[7px] w-[7px] rounded-full", ok ? "bg-good" : "bg-warn")} />
      {children}
    </span>
  );
}

/**
 * One setting. `help`: what it does, behind the ? after its name. `sub`: a short state under the name (a key
 * that is saved). `start`: the control reads from the left (chips of facts) rather than sitting on the right.
 * `tone="warn"`: something to do, said by the name and its button. `setting`: the Settings search's anchor(s), see settingHref.
 */
export function Row({ label, help, htmlFor, sub, start, tone, setting, children }: {
  label: ReactNode;
  help?: string;
  htmlFor?: string;
  sub?: ReactNode;
  start?: boolean;
  tone?: "warn";
  setting?: string;
  children?: ReactNode;
}) {
  const dense = useContext(Dense);
  const name = typeof label === "string" ? label : undefined;
  // the name may be in two pieces (the ? held to the last word): each is a label of the control, read as one
  const wrapIn = (text: ReactNode) => (htmlFor ? <label htmlFor={htmlFor} className="min-w-0">{text}</label> : <span className="min-w-0">{text}</span>);
  return (
    <div data-setting={setting} className={cx("grid items-center", dense ? "min-h-[48px] grid-cols-[150px_minmax(0,1fr)] gap-3.5 px-4 py-1.5" : "min-h-[52px] grid-cols-[230px_minmax(0,1fr)] gap-4 px-[18px] py-2", tone === "warn" && "bg-warn-wash/50")}>
      <span className="flex min-w-0 flex-col">
        <span className={cx("flex min-w-0 items-center gap-1.5 text-body", dense && "font-semibold", tone === "warn" && "font-semibold text-warn-ink")}>
          {name !== undefined && help ? (
            // a name that wraps keeps its ? after its last word, held to it: beside the wrapped name, a ? of its own sat
            // at the column's edge ("Compare opens on original vs result")
            <span className="min-w-0">
              {name.slice(0, name.lastIndexOf(" ") + 1) && wrapIn(name.slice(0, name.lastIndexOf(" ") + 1))}
              <span className="whitespace-nowrap">{wrapIn(name.slice(name.lastIndexOf(" ") + 1))}<Help text={help} title={name} className="relative -top-[1.5px] ml-1.5 align-middle" /></span>
            </span>
          ) : (
            <>
              {wrapIn(label)}
              {help && <Help text={help} title={name} />}
            </>
          )}
        </span>
        {sub && <span className="mt-0.5 text-meta text-ink-3">{sub}</span>}
      </span>
      <div className={cx("flex min-w-0 flex-wrap items-center gap-2", start ? "justify-start" : "justify-end")}>{children}</div>
    </div>
  );
}

/** What is not one setting: a list, an editor, an error. Full width, padded like the rows. */
export function Block({ children, className, setting }: { children: ReactNode; className?: string; setting?: string }) {
  const dense = useContext(Dense);
  return <div data-setting={setting} className={cx("flex flex-col gap-2", dense ? "px-4 py-3" : "px-[18px] py-3", className)}>{children}</div>;
}

/** A fact in a row: a version, a size, a count. */
export function Fact({ children, tip }: { children: ReactNode; tip?: string }) {
  return <Chip tip={tip} className="font-mono text-meta font-medium">{children}</Chip>;
}
