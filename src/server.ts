/**
 * The local dashboard: a page at http://localhost:4747 plus the small JSON API it calls.
 * Listens on 127.0.0.1 only, so nothing is reachable from other machines.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Profile } from "./config.ts";
import { STATUSES } from "./domain.ts";
import type { Store } from "./store.ts";
import { deadlinesCalendar, viewOf } from "./views.ts";

const PAGE = new URL("./ui/dashboard.html", import.meta.url);

export function startServer(
  store: Store,
  profile: Profile,
  port: number,
  clock = () => new Date(),
  sourceNames: Record<string, string> = {},
): Server {
  const page = readFileSync(PAGE, "utf8");
  const server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => send(res, 400, { error: error.message }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const now = clock();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/items") {
      send(res, 200, {
        profile: { name: profile.name, timezone: profile.timezone, topics: profile.topics.map((t) => t.name), thresholds: profile.thresholds, statuses: STATUSES },
        items: store.items(profile.id).map((item) => viewOf(item, profile, now, sourceNames)),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/deadlines.ics") {
      res
        .writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="research-radar-deadlines.ics"' })
        .end(deadlinesCalendar(store.items(profile.id), profile, now));
      return;
    }

    const action = url.pathname.match(/^\/api\/items\/(\d+)\/(status|vote|dismiss)$/);
    if (req.method === "POST" && action) {
      const id = Number(action[1]);
      const body = (await readJson(req)) as Record<string, unknown>;
      if (action[2] === "status") store.setStatus(id, profile.id, (body.status as string | null) ?? null);
      if (action[2] === "dismiss") store.setDismissed(id, profile.id, body.dismissed === true);
      if (action[2] === "vote") {
        const vote = body.vote;
        if (vote !== 1 && vote !== -1 && vote !== null) throw new Error("vote must be 1, -1 or null");
        store.setVote(id, profile.id, vote, now);
      }
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: "Not found" });
  }

  return server.listen(port, "127.0.0.1");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
