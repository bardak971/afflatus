import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Asks the OS not to sleep while a rented pod works (card #320): asleep, this PC stops driving the pod, which bills until its
 * watchdog stops it (2026-11-05: the PC slept 2 min after a test pod came up, $0.12 billed for nothing). The display may
 * still sleep. No npm package: each OS's own tool is started as a child that holds the ask while it lives, and ended when
 * no pod works:
 * - Windows: a PowerShell that calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and waits on its stdin;
 * - Linux: systemd-inhibit --what=sleep around a `cat` of its stdin;
 * - macOS: caffeinate -i, told to end with this process (-w).
 * Each ends of itself when Afflatus dies, however it dies: the stdin pipe closes under the first two, caffeinate watches
 * Afflatus's pid. A PC left awake for good by a child Afflatus forgot was the thing to avoid.
 */

/** Starts a child process (node's spawn; a test's stand-in). */
export type Spawner = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED: the system stays up, the display may sleep, until this thread says otherwise or ends. */
const ES_HOLD = 0x80000001;

/** The PowerShell the Windows hold runs: the ask, then a wait until Afflatus closes its stdin (or dies). */
const WINDOWS_HOLD = [
  `$k = Add-Type -Name Power -Namespace AfflatusAwake -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
  `if ($k::SetThreadExecutionState([uint32]${ES_HOLD}) -eq 0) { exit 3 }`,
  `[void][Console]::In.ReadToEnd()`,
].join("; ");

/** The command that holds the ask on a platform, for Afflatus's pid; null where there is none. */
export function holdCommand(platform: NodeJS.Platform, pid: number): { cmd: string; args: string[] } | null {
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_HOLD, "utf16le").toString("base64")] };
  if (platform === "linux") return { cmd: "systemd-inhibit", args: ["--what=sleep", "--who=Afflatus", "--why=A rented GPU is working", "--mode=block", "cat"] };
  if (platform === "darwin") return { cmd: "caffeinate", args: ["-i", "-w", String(pid)] };
  return null;
}

export class KeepAwake {
  private child: ChildProcess | null = null;
  /**
   * Why the hold could not be had (its tool not there, or it ended of itself): said in the log once, until it is not wanted
   * any more. A tool missing is tried again at each ask (a read of RunPod's), and said only the first time.
   */
  private why: string | null = null;
  private readonly spawn: Spawner;
  private readonly command: { cmd: string; args: string[] } | null;

  /** `command`: null for one that holds nothing (Rented's until the server's start gives the real one); left out, the platform's. */
  constructor(o: { platform?: NodeJS.Platform; spawn?: Spawner; pid?: number; command?: null } = {}) {
    this.spawn = o.spawn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.command = o.command === null ? null : holdCommand(o.platform ?? process.platform, o.pid ?? process.pid);
  }

  /** The ask is held now: its child runs. */
  get held(): boolean {
    return this.child !== null;
  }

  /** Why it was not held while wanted (its tool missing, or it ended); null once it is not wanted. `held` says whether a retry holds it now. */
  get failed(): string | null {
    return this.why;
  }

  /** Held or not. Wanted again after its child ended, it is started again (at the caller's next say, not in a loop). */
  set(want: boolean): void {
    if (want) return this.start();
    // not wanted: nothing is said to have failed either
    this.why = null;
    this.end();
  }

  /** Afflatus stopping: the ask is ended now. */
  stop(): void {
    this.end();
  }

  private start(): void {
    if (this.child || !this.command) return;
    let child: ChildProcess;
    try {
      // its stdin a pipe this process holds: closed when Afflatus ends, the child ends with it
      child = this.spawn(this.command.cmd, this.command.args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch (err) {
      this.fail(`${this.command.cmd} could not be started: ${(err as Error).message}`);
      return;
    }
    this.child = child;
    // a child that ends of itself (its tool missing, an ask refused) leaves the hold to be had at the next say
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(why);
    };
    child.once("error", (err) => gone(`${this.command!.cmd}: ${err.message}`));
    child.once("exit", (code, signal) => gone(`${this.command!.cmd} ended (${signal ?? `code ${code}`})`));
    // a write to a stdin closed under it is not an error of Afflatus's
    child.stdin?.on("error", () => {});
  }

  private end(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin?.end();
    child.kill();
  }

  private fail(why: string): void {
    if (this.why === null) console.warn(`[awake] this PC may sleep while a rented GPU works: ${why}`);
    this.why = why;
  }
}
