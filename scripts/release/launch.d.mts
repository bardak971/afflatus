// The types of launch.mjs, for the tests that import it (apps/server/test/releaseLaunch.test.ts).
export declare const RESTART: 75;
export type Next = { action: "restart" } | { action: "fallback"; to: string } | { action: "stop"; code: number };
export declare function decide(s: { code: number | null; signal: string | null; started: boolean; version: string; previous: string | null; previousInstalled: boolean }): Next;
export declare function readLine(file: string): string | null;
export declare function installed(root: string, version: string): boolean;
