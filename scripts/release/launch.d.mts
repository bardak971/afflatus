// The types of launch.mjs, for the tests that import it (apps/server/test/releaseLaunch.test.ts).
export declare const RESTART: 75;
export declare const PORT_TAKEN: 3;
export declare const DATA_FOLDER: 4;
export type Next = { action: "restart" } | { action: "fallback"; to: string } | { action: "stop"; code: number };
export declare function decide(s: { code: number | null; signal: string | null; started: boolean; version: string; trial: string | null; previous: string | null; previousInstalled: boolean }): Next;
export declare function versionName(name: unknown): string | null;
export declare function clearStaleMarkers(versionDir: string, isAlive?: (pid: number) => boolean): void;
export declare function restoreLibrary(dataDir: string, version: string, at?: Date): string | null | false;
export declare function readLine(file: string): string | null;
export declare function installed(root: string, version: string): boolean;
export declare function stopLine(s: { code: number | null; signal: string | null; log: string | null }): string;
export declare const LOG_DAYS: number;
export declare const LOG_MAX: number;
export interface Log {
  readonly path: string | null;
  write(text: string, from?: string): void;
  say(line: string, err?: boolean): void;
  close(): void;
}
export declare function openLog(dir: string, o?: { now?: () => Date; max?: number; days?: number; warn?: (line: string) => void }): Log;
