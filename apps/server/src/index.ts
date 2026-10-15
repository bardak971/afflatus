import { loadConfig } from "./config";
import { check, DataFolderError, EXIT_DATA_FOLDER, EXIT_PORT_TAKEN, PortTakenError, resetPasswordCommand, start, webDir } from "./start";

// the start itself is in start.ts, where a test runs it; here only what a process does around it: a start that cannot go
// on is said in one line and ends the process, and a signal stops the server before the process ends
const config = loadConfig();
// the check an update runs on a new version before it switches to it (start.ts check): nothing is started
if (process.argv.includes("--check")) process.exit(await check(config));
// the password and every session removed, without the page (access.ts resetAccess): with Afflatus stopped
if (process.argv.includes("reset-password")) process.exit(await resetPasswordCommand(config));
let started: Awaited<ReturnType<typeof start>>;
try {
  started = await start(config, { webDir: webDir() });
} catch (err) {
  // each with its own code, which the bundle's launcher does not take for a new version that does not start
  if (err instanceof PortTakenError || err instanceof DataFolderError) {
    console.error(err.message);
    process.exit(err instanceof PortTakenError ? EXIT_PORT_TAKEN : EXIT_DATA_FOLDER);
  }
  throw err;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await started.close();
    process.exit(0);
  });
}
