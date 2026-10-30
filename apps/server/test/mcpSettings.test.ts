import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { SETTING_HELP } from "@afflatus/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kindOf } from "../src/mcpSettings";
import { readSettings, settingsSchema, updateSettings } from "../src/settings";
import { makeApp, makeFake, type TestApp } from "./helpers";

/**
 * The settings through MCP (mcpSettings.ts), through the SDK's client: every setting of the schema is said one way or
 * another (a new one fails here until it is), the never-list refused whatever the scopes, secrets never read back nor
 * written, and a change saved as the page saves it, with its checks.
 */

let fake: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

async function connect(scopes: string[]): Promise<Client> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test settings", start: "look" } });
  expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${res.json().view.id as string}`, payload: { scopes } })).statusCode).toBe(200);
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as AddressInfo).port;
  const client = new Client({ name: "Claude Code", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${res.json().token as string}` } } }));
  return client;
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called) => (r.content as Array<{ text?: string }>)[0]!.text!;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r)) as Record<string, any>;
};
const refused = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  return textOf(r);
};

const ALL = ["look", "make", "spend", "manage"];

describe("every setting is said", () => {
  it("each field of the schema is one an agent changes, a never-list's, a secret, or one kept elsewhere", () => {
    const none = Object.keys(settingsSchema.shape).filter((k) => kindOf(k) === null);
    expect(none, "a setting of the schema MCP says nothing about: give it a \"?\" text in SETTING_HELP, or a kind in mcpSettings.ts").toEqual([]);
  });

  it("each \"?\" text is of a setting the schema has", () => {
    const shape = settingsSchema.shape as Record<string, unknown>;
    for (const key of Object.keys(SETTING_HELP)) expect(shape[key.split(".")[0]!], key).toBeDefined();
  });
});

describe("read_settings", () => {
  it("says each setting with its value and \"?\" text; one with its schema; secrets said set, never read back", async () => {
    await updateSettings(t.db, () => ({
      runpodKey: "rpa_SECRET_runpod_0123456789", civitaiKey: "SECRET_civitai_key", huggingFaceToken: "hf_SECRET_token", runpodS3User: "user_SECRET", runpodS3Secret: "SECRET_s3",
      llms: [{ id: "main", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen", apiKey: "sk-SECRET-llm" }],
      notify: { telegramToken: "123456789:AAE_SECRET_0123456789abcdef", telegramChat: "@SECRET_chat", discordWebhook: "https://discord.com/api/webhooks/1/SECRET" },
    }));
    const c = await connect(["look"]);
    const all = await ok(c, "read_settings");
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/SECRET/);
    const by = new Map((all.settings as Array<{ key: string; value: unknown }>).map((x) => [x.key, x]));
    expect(by.get("runpodKey")).toMatchObject({ value: { set: true }, changed: "in Afflatus itself (a secret)" });
    expect(by.get("civitaiKey")).toMatchObject({ value: { set: true } });
    expect(by.get("unkeptDays")).toMatchObject({ value: 1, help: SETTING_HELP.unkeptDays, changed: "change_setting" });
    expect(by.get("machines")).toMatchObject({ changed: expect.stringContaining("edit_machine") });
    // the never-list is not read at all
    for (const key of ["access", "afflatusUpdateChecks"]) expect(by.has(key), key).toBe(false);
    expect(by.get("notify")!.value).toEqual({ picture: true, events: expect.not.objectContaining({ newDevice: expect.anything() }) });
    const one = await ok(c, "read_settings", { key: "rentCaps.day" });
    expect(one).toMatchObject({ key: "rentCaps.day", value: 0, help: SETTING_HELP.rentCaps });
    expect(one.schema).toMatchObject({ type: "object", properties: { day: { type: "number", minimum: 0 } } });
    expect(await refused(c, "read_settings", { key: "access.stayDays" })).toMatch(/the Sign-in settings cannot be reached through MCP/);
    expect(await refused(c, "read_settings", { key: "notify.telegramToken" })).toMatch(/cannot be reached through MCP/);
    await c.close();
  });
});

describe("read_settings: folders on a disk", () => {
  it("says comfyDir and downloadPlaces set or not, never the path; no value read looks like a path on a disk", async () => {
    await updateSettings(t.db, () => ({ comfyDir: "D:\\zz-test\\ComfyUI", downloadPlaces: { m1: { loras: "E:\\zz-test\\loras" } } }));
    const c = await connect(["look"]);
    const all = await ok(c, "read_settings");
    const by = new Map((all.settings as Array<{ key: string; value: unknown }>).map((x) => [x.key, x]));
    expect(by.get("comfyDir")!.value).toEqual({ set: true });
    expect(by.get("downloadPlaces")!.value).toEqual({ set: true });
    expect(JSON.stringify(all)).not.toContain("zz-test");
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    for (const x of all.settings as Array<{ value: unknown }>) walk(x.value);
    for (const v of strings) expect(v, v).not.toMatch(/^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/);
    expect((await ok(c, "read_settings", { key: "comfyDir" })).value).toEqual({ set: true });
    await c.close();
  });
});

describe("change_setting", () => {
  it("saves as the page does, with the schema's checks; a dotted path reaches inside one; null takes a family's key out", async () => {
    const c = await connect(ALL);
    expect(await ok(c, "change_setting", { key: "rentCaps.month", value: 25 })).toEqual({ key: "rentCaps.month", was: 0, now: 25 });
    expect((await readSettings(t.db)).rentCaps).toEqual({ day: 0, month: 25 });
    await ok(c, "change_setting", { key: "finish.route", value: "rtx" });
    expect((await readSettings(t.db)).finish).toMatchObject({ route: "rtx", factor: 2 });
    await ok(c, "change_setting", { key: "families.sdxl", value: false });
    expect((await readSettings(t.db)).families).toEqual({ sdxl: false });
    await ok(c, "change_setting", { key: "families.sdxl", value: null });
    expect((await readSettings(t.db)).families).toEqual({});
    await ok(c, "change_setting", { key: "notify.events.renderDone", value: { telegram: true, discord: false } });
    expect((await readSettings(t.db)).notify.events.renderDone).toEqual({ telegram: true, discord: false });
    // the schema's checks: an unkept time it does not offer, a cap below 0, a setting that is not one
    expect(await refused(c, "change_setting", { key: "unkeptDays", value: 5 })).toMatch(/unkeptDays/);
    expect(await refused(c, "change_setting", { key: "rentCaps.day", value: -1 })).toMatch(/rentCaps/);
    expect(await refused(c, "change_setting", { key: "nonsense", value: 1 })).toMatch(/There is no setting called nonsense/);
    expect(await refused(c, "change_setting", { key: "machines", value: [] })).toMatch(/edit_machine/);
    expect(await refused(c, "change_setting", { key: "acceptedPresets", value: ["shipped:minimax-h3"] })).toMatch(/licence is accepted by the user's own tick/);
    await c.close();
  });

  it("refuses the never-list whatever the scopes, and the secrets, and leaves them as they were", async () => {
    await updateSettings(t.db, () => ({ runpodKey: "rpa_kept_0123456789", notify: { telegramChat: "@kept" } }));
    const before = await readSettings(t.db);
    const c = await connect(ALL);
    for (const key of ["access.stayDays", "access.password", "access", "afflatusUpdateChecks", "notify.telegramToken", "notify.telegramChat", "notify.discordWebhook", "notify.events.newDevice"]) {
      expect(await refused(c, "change_setting", { key, value: null }), key).toMatch(/cannot be reached through MCP, whatever the token's scopes/);
    }
    // notify sent whole, or its events with the new-device notice in them, names where notices go: refused too
    expect(await refused(c, "change_setting", { key: "notify", value: { telegramChat: "@evil" } })).toMatch(/cannot be reached through MCP/);
    expect(await refused(c, "change_setting", { key: "notify.events", value: { newDevice: { telegram: false } } })).toMatch(/cannot be reached through MCP/);
    for (const key of ["runpodKey", "civitaiKey", "huggingFaceToken", "runpodS3Secret"]) {
      expect(await refused(c, "change_setting", { key, value: "x" }), key).toMatch(/is a secret: it is pasted in Afflatus itself/);
    }
    const after = await readSettings(t.db);
    expect(after.runpodKey).toBe(before.runpodKey);
    expect(after.notify).toEqual(before.notify);
    expect(after.access).toEqual(before.access);
    // each written to the activity as refused
    const id = (await t.services.mcp.tokens.list())[0]!.id;
    const lines = await t.services.mcp.tokens.activity(id);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((l) => l.refused)).toBe(true);
    await c.close();
  });

  it("needs Manage", async () => {
    const c = await connect(["look", "make", "spend"]);
    expect(await refused(c, "change_setting", { key: "unkeptDays", value: 3 })).toMatch(/needs Manage/);
    await c.close();
  });
});
