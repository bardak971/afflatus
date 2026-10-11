/**
 * The server, as the drawn tests answer for it: `fetch` stood in for (setup.ts), each request written down, and answered
 * by what a test set with `on`, else 404 (the screens draw on with nothing read, as when the server is away). A test
 * says what it expects asked rather than mocking the api module, so the app's own requests are what is tested.
 */

/** A request the page made: its method, its path under /api with the query, and its JSON body when it had one. */
export interface Asked {
  method: string;
  path: string;
  body: unknown;
}

/** What answers a request: a value (sent as JSON, 200), a Response as it is, or a promise of either (a request left pending). */
type Handler = (req: { params: Record<string, string>; body: unknown; path: string }) => unknown;

interface Route {
  method: string;
  match: RegExp;
  names: string[];
  handler: Handler;
}

let routes: Route[] = [];
const asked: Asked[] = [];

/** A JSON answer, as the server sends one (an error is `{ error }` with its status). */
export const jsonAnswer = (value: unknown, status = 200) => new Response(JSON.stringify(value ?? {}), { status, headers: { "Content-Type": "application/json" } });

export const fakeApi = {
  /**
   * Answers `"POST /assets/:id/mirror"` (the path under /api, without its query) with `handler`; a later `on` for the
   * same request goes first.
   */
  on(route: string, handler: Handler | object): void {
    const [method, path] = route.split(" ") as [string, string];
    const names: string[] = [];
    const match = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_m, name: string) => {
      names.push(name);
      return "([^/]*)";
    })}$`);
    routes.unshift({ method, match, names, handler: typeof handler === "function" ? (handler as Handler) : () => handler });
  },
  /** The requests made to `method` and a path that starts with `start`. */
  calls(method: string, start: string): Asked[] {
    return asked.filter((a) => a.method === method && a.path.startsWith(start));
  },
  reset(): void {
    routes = [];
    asked.length = 0;
  },
  fetch: async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://afflatus.test");
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api/, "");
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // a body that is not JSON is kept as it came
      }
    }
    asked.push({ method, path: path + url.search, body });
    if (!url.pathname.startsWith("/api/")) return new Response("", { status: 404 });
    for (const r of routes) {
      const m = r.method === method ? r.match.exec(path) : null;
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]));
      const answer = await r.handler({ params, body, path });
      return answer instanceof Response ? answer : jsonAnswer(answer);
    }
    return jsonAnswer({ error: "not answered in this test" }, 404);
  },
};

/** An answer a test lets go of when it wants: the request stays pending until then (an upload under way). */
export function later<T = unknown>(): { promise: Promise<T>; answer(value: T): void } {
  let answer!: (value: T) => void;
  const promise = new Promise<T>((done) => (answer = done));
  return { promise, answer };
}
