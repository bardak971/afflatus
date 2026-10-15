/**
 * Class names joined, the false ones left out: `cx("a", on && "b")`. A module of its own so that the progress bars,
 * which ui.tsx imports, use the same one without importing ui.tsx back (they each had a copy).
 */
export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
