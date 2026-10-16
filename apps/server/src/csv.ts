import type { FastifyReply } from "fastify";

/**
 * The CSV files the Queue's tabs export (Costs, Render times): RFC 4180, comma-separated with a dot for decimals and CRLF
 * line ends, UTF-8 with a byte order mark so that Excel reads accents. A spreadsheet takes a text cell starting with = + - @
 * (or a tab or CR) as a formula: a machine's name or a model file is the user's own text, so such a cell gets an apostrophe
 * in front, which spreadsheets show as text.
 */

export type CsvCell = string | number | boolean | null | undefined;

const BOM = "﻿";
const FORMULA = /^[=+\-@\t\r]/;
const QUOTED = /[",\r\n]/;

/** One cell as written: nothing for no value, a number as JavaScript writes it, a text guarded and quoted when it must be. */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const text = FORMULA.test(v) ? `'${v}` : v;
  return QUOTED.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole file: its header line, then a line per row, each ended by CRLF, after the byte order mark. */
export function csvOf(headers: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  return BOM + [headers, ...rows].map((r) => r.map(csvCell).join(",") + "\r\n").join("");
}

/** Milliseconds as seconds to the tenth: what a time is said to in the files. */
export const seconds = (ms: number | null | undefined): number | null => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : Math.round(ms / 100) / 10);
/** Dollars to four decimals: a render on a cheap GPU is a fraction of a cent. */
export const dollars4 = (usd: number | null | undefined): number | null => (usd === null || usd === undefined || !Number.isFinite(usd) ? null : Math.round(usd * 10_000) / 10_000);
/** A moment as ISO 8601 in UTC ("2026-10-16T09:30:00.000Z"): the files' headers say `_utc`. */
export const utc = (ms: number | null | undefined): string | null => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

/** The file's name: what it is and the days of its window (UTC), "all" without one: "afflatus-costs-2026-10-01_2026-10-16.csv". */
export function csvName(what: string, window: { from?: number; to?: number }): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const span = window.from !== undefined && window.to !== undefined ? `${day(window.from)}_${day(window.to)}` : "all";
  return `afflatus-${what}-${span}.csv`;
}

/** The file sent as a download, never kept by the browser (it is the window as it stands). */
export function sendCsv(reply: FastifyReply, name: string, body: string): FastifyReply {
  return reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${name}"`)
    .header("Cache-Control", "no-store")
    .send(body);
}
