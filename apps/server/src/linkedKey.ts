/**
 * How a file of a linked folder is named in a row: "linked:" and its path on the disk (linked.ts). On its own so that
 * what erases (sweep.ts), which linked.ts reads in turn, can tell such a file apart without the two importing each other.
 */
export const LINKED = "linked:";
export const isLinked = (key: string) => key.startsWith(LINKED);
