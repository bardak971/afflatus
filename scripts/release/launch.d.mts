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
