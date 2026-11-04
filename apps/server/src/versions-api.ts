import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AssetLookup } from "./assets-api";
import type { Services } from "./services";
import { keepAllVersions, keepVersion, versionsOf } from "./versions";

/** A picture's versions (versions.ts): its stack as the Stage's strip reads it, Keep one, Keep all as pictures. */
export function registerVersions(app: FastifyInstance, s: Services, lookup: AssetLookup): void {
  /** The stack an item is in, by any id of it (the head's or a version's): `{ head, versions }`, the versions oldest first. */
  app.get<{ Params: { id: string } }>("/api/assets/:id/versions", async (req) => versionsOf(s, req.params.id));
  /** One version kept in the head's place (its id), or the head itself (its own id): the stack after. */
  app.post<{ Params: { id: string } }>("/api/assets/:id/versions/keep", async (req) => {
    const { version } = z.object({ version: z.string().min(1).max(64) }).parse(req.body);
    return keepVersion(s, lookup, req.params.id, version);
  });
  /** Every version kept as a picture of its own beside the head: the stack after. */
  app.post<{ Params: { id: string } }>("/api/assets/:id/versions/keep-all", async (req) => keepAllVersions(s, lookup, req.params.id));
}
