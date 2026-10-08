/** What was typed but not sent, per conversation: kept while the designer is closed and opened again, and across a reload. */
const typed = new Map<string, string>();

export const recall = (key: string | undefined) => {
  if (!key) return "";
  if (typed.has(key)) return typed.get(key)!;
  try {
    return sessionStorage.getItem(`afflatus:designer:${key}`) ?? "";
  } catch {
    return "";
  }
};

export const keep = (key: string | undefined, text: string) => {
  if (!key) return;
  typed.set(key, text);
  try {
    if (text) sessionStorage.setItem(`afflatus:designer:${key}`, text);
    else sessionStorage.removeItem(`afflatus:designer:${key}`);
  } catch {
    /* no storage: kept for the session only */
  }
};
