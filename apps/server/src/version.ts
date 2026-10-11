// Version numbers compared: the node pack's (nodePack.ts) and the least one a download through it needs (downloads.ts).
// Apart from both, so that downloads.ts imports nothing of nodePack.ts (whose routes take the services, downloads among them).

/** Whether version `a` comes before `b`, part by part as numbers ("0.9.0" before "0.10.0"). */
export const olderThan = (a: string, b: string): boolean => {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};
