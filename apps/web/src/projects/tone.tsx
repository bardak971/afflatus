import { Inbox } from "lucide-react";

/** The theme's colours a project can wear in the rail: tokens, so that it follows the theme. */
const TONES = ["--color-picture", "--color-good", "--color-warn-ink", "--color-accent", "--color-warn"];
/** A project's colour, the same every time: picked from its id. */
export function projectTone(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(${TONES[h % TONES.length]})`;
}

/** What a project's square shows: its initial (the name beside or in the tip says it), the Inbox its icon. */
export function Initial({ name, inbox, size = 15 }: { name: string; inbox?: boolean; size?: number }) {
  return inbox ? <Inbox size={size} /> : <>{(Array.from(name.trim())[0] ?? "…").toUpperCase()}</>;
}
