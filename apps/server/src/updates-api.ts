import type { FastifyInstance, FastifyRequest } from "fastify";
import { httpError } from "./errors";
import { fromThisComputer } from "./hostCheck";
import type { AfflatusUpdates } from "./updates";

/**
 * Afflatus's own updates (updates.ts), for Settings → About. Anyone who can open the page reads where they stand; only
 * the computer Afflatus runs on changes anything (checks, updates, goes back, brings a 0.3 library over): the LAN may be
 * open by choice, and installing stays with whoever sits at the machine. A request through a proxy (one that says whom
 * it forwards for) is not taken as from this computer, even when the proxy itself runs on it; nor is one whose Host is
 * not a loopback name, which a proxy on this computer that says nothing of whom it forwards for still passes on as the
 * name it is reached by (docs/configuration.md).
 */

export function registerUpdates(app: FastifyInstance, updates: AfflatusUpdates): void {
  const here = (req: FastifyRequest) => {
    if (!fromThisComputer(req)) throw httpError("Updates are done on the computer Afflatus runs on, not from another one.", 403);
  };

  /** Where Afflatus stands: its version, the latest release, an update under way, the previous version, the 0.3 move. */
  app.get("/api/updates", async (req) => updates.view(fromThisComputer(req)));

  /** Ask GitHub now (Check now). */
  app.post("/api/updates/check", async (req) => {
    here(req);
    await updates.check();
    return updates.view(true);
  });

  /** Update to the latest release: it goes on in the background, its steps on the event stream ("updates"). */
  app.post("/api/updates/update", async (req) => {
    here(req);
    await updates.update(true);
    return updates.view(true);
  });

  /** Not now / Cancel: the update stopped before it switches; a failed one forgotten. */
  app.post("/api/updates/cancel", async (req) => {
    here(req);
    await updates.cancel();
    return updates.view(true);
  });

  /** What Go back would leave on RunPod, for its question: refused while a rented GPU runs or a hunt is on; what keeps billing. */
  app.get("/api/updates/go-back", async (req) => {
    here(req);
    return updates.goBackCheck();
  });

  /** Back to the previous version, with the library as it was at the update; Afflatus restarts. */
  app.post("/api/updates/go-back", async (req) => {
    here(req);
    await updates.goBack();
    return updates.view(true);
  });

  /** Bring the 0.3 library beside this bundle in (moved, not copied); Afflatus restarts. */
  app.post("/api/updates/move", async (req) => {
    here(req);
    await updates.moveIn();
    return updates.view(true);
  });
}
