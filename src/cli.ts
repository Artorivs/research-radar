/**
 * Command line entry point.
 *
 *   npm run radar -- collect [--limit N] [--provider claude|ollama]   read every Source and file new Items
 *   npm run radar -- sources   check that every feed in config/sources.json can be read
 *   npm run radar -- forget-papers   drop unsaved Papers so the next collect refilters them
 *   npm run radar -- serve [--port 4747]   open the dashboard at http://localhost:4747
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadProfile, loadSources, withOpenAlexKey } from "./config.ts";
import { chooseAssessor } from "./provider.ts";
import { checkFeeds, collect } from "./radar.ts";
import { startServer } from "./server.ts";
import type { Fetch } from "./sources/entry.ts";
import { Store } from "./store.ts";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string", default: resolve(root, "config/profile.json") },
    sources: { type: "string", default: resolve(root, "config/sources.json") },
    db: { type: "string", default: process.env.RADAR_DB ?? resolve(root, "data/radar.sqlite") },
    port: { type: "string", default: "4747" },
    limit: { type: "string" },
    provider: { type: "string" },
  },
});

const profile = loadProfile(values.profile);
mkdirSync(dirname(values.db), { recursive: true });
const store = new Store(values.db);

switch (positionals[0]) {
  case "collect": {
    const { provider, model, assess } = chooseAssessor(profile, process.env, fetch as Fetch, values.provider);
    console.log(`Assessing with ${provider} (${model})`);
    const report = await collect({
      profile,
      sources: withOpenAlexKey(loadSources(values.sources), process.env.OPENALEX_API_KEY),
      store,
      assess,
      fetch: fetch as Fetch,
      now: new Date(),
      limitPerSource: values.limit ? Number(values.limit) : undefined,
      log: (line) => console.log(line),
    });
    console.log(
      `\nRead ${report.entriesRead} entries; assessed ${report.entriesAssessed}; ` +
        `${report.itemsAdded} new Items, ${report.itemsMerged} merged, ${report.versionsAdded} new Versions` +
        (report.entriesDeferred ? `; ${report.entriesDeferred} left for the next run (--limit)` : ""),
    );
    for (const f of report.failures) console.error(`  ✗ ${f}`);
    if (report.stopped) console.error(`\nStopped early: ${report.stopped}\nNothing was lost; the next run picks up the remaining Entries.`);
    store.close();
    process.exitCode = report.stopped || (report.failures.length > 0 && report.entriesAssessed === 0) ? 1 : 0;
    break;
  }
  case "sources": {
    const lines = await checkFeeds(loadSources(values.sources).feeds, fetch as Fetch);
    for (const line of lines) console.log(line);
    store.close();
    break;
  }
  case "forget-papers": {
    const removed = store.forgetPapers();
    console.log(`Removed ${removed} Papers you hadn't saved, voted on or dismissed. The next collect reads OpenAlex afresh through the current filters.`);
    store.close();
    break;
  }
  case "serve": {
    const port = Number(values.port);
    startServer(store, profile, port);
    console.log(`Research Radar for ${profile.name}: http://localhost:${port}`);
    break;
  }
  default:
    console.log("Usage: npm run radar -- collect [--limit N] [--provider claude|ollama] | sources | forget-papers | serve [--port 4747]");
    process.exitCode = positionals[0] ? 1 : 0;
}
