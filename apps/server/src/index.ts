import { loadConfig } from "./config";
import { DataFolderError, PortTakenError, start, webDir } from "./start";

// the start itself is in start.ts, where a test runs it; here only what a process does around it: a start that cannot go
// on is said in one line and ends the process, and a signal stops the server before the process ends
const config = loadConfig();
let started: Awaited<ReturnType<typeof start>>;
try {
  started = await start(config, { webDir: webDir() });
} catch (err) {
  if (err instanceof PortTakenError || err instanceof DataFolderError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await started.close();
    process.exit(0);
  });
}
