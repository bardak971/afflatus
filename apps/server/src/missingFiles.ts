/**
 * The files of linked folders known not to be on the disk any more, by key ("linked:<path>"). Such a file keeps its
 * row while something uses it (a timeline's take, a person's picture: Linked.scan); the library then says it is
 * missing (assetView) instead of drawing a tile whose picture never comes. Found by a reading of its folder or when the
 * file is asked for, and forgotten when it is found again. Kept in memory: the readings at start find them again.
 */
const gone = new Set<string>();

export const missingFiles = {
  has: (key: string) => gone.has(key),
  mark: (key: string) => void gone.add(key),
  found: (key: string) => void gone.delete(key),
};
