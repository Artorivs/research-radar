/**
 * One collection run: read every Source, skip Entries already seen, assess the rest, and file the
 * resulting Items into the Store, merging duplicates and new Versions into what is already there.
 */
import { StopRun, type Assessor, type AssessedItem } from "./assess.ts";
import type { Profile, SourcesConfig } from "./config.ts";
import { isEvent, seriesKeyFor, type Deadline, type Kind } from "./domain.ts";
import type { Entry, Fetch } from "./sources/entry.ts";
import { readFeed } from "./sources/feed.ts";
import { readOpenAlex } from "./sources/openalex.ts";
import { readPage } from "./sources/page.ts";
import type { NewItem, Store } from "./store.ts";

/** How far a net 👍 or 👎 on earlier Events in a Series moves a new Event's Score. */
export const SERIES_VOTE_SHIFT = 2;
const CALIBRATION_VOTES = 30;

export interface RunReport {
  entriesRead: number;
  entriesAssessed: number;
  itemsAdded: number;
  itemsMerged: number;
  versionsAdded: number;
  /** New Entries held back by limitPerSource; they are read on a later run. */
  entriesDeferred: number;
  failures: string[];
  /** Why the run ended early, if it did (see StopRun). */
  stopped: string | null;
}

export interface RunDeps {
  profile: Profile;
  sources: SourcesConfig;
  store: Store;
  assess: Assessor;
  fetch: Fetch;
  now: Date;
  /** Caps how many new Entries each Source contributes per run, for a cheap first try. */
  limitPerSource?: number;
  log?: (line: string) => void;
}

export async function collect(deps: RunDeps): Promise<RunReport> {
  const { profile, sources, store, fetch, now } = deps;
  const log = deps.log ?? (() => {});
  const report: RunReport = { entriesRead: 0, entriesAssessed: 0, itemsAdded: 0, itemsMerged: 0, versionsAdded: 0, entriesDeferred: 0, failures: [], stopped: null };

  const readers: Array<[string, () => Promise<Entry[]>]> = [
    ["OpenAlex", () => readOpenAlex(profile, sources.openalex, fetch, now)],
    ...sources.feeds.filter((feed) => feed.enabled !== false).map((feed): [string, () => Promise<Entry[]>] => [feed.name, () => readFeed(feed, fetch)]),
    ...sources.pages.filter((page) => page.enabled !== false).map((page): [string, () => Promise<Entry[]>] => [page.name, () => readPage(page, fetch, now)]),
  ];

  for (const [name, read] of readers) {
    let entries: Entry[];
    try {
      entries = await read();
    } catch (error) {
      report.failures.push(`${name}: ${describe(error)}`);
      log(`${name}: couldn't read it (${describe(error)})`);
      continue;
    }
    const unseen = entries.filter((e) => e.entryId && !store.hasSeen(e.source, e.entryId));
    const fresh = unseen.slice(0, deps.limitPerSource ?? Infinity);
    report.entriesRead += entries.length;
    report.entriesDeferred += unseen.length - fresh.length;
    log(`${name}: ${entries.length} entries, ${unseen.length} new`);
    for (const [i, entry] of fresh.entries()) {
      // Each line is written before the Entry is assessed, so a slow local model visibly works on something.
      log(`  ${i + 1}/${fresh.length} ${entry.title}`);
      const started = Date.now();
      const took = () => `${Math.round((Date.now() - started) / 1000)}s`;
      try {
        const found = await fileEntry(entry, deps, report);
        store.markSeen(entry.source, entry.entryId, now);
        log(found === null ? "      already in the archive" : `      ${found} ${found === 1 ? "Item" : "Items"} in ${took()}`);
      } catch (error) {
        if (error instanceof StopRun) {
          report.stopped = error.message;
          return report;
        }
        report.failures.push(`${name} "${entry.title}": ${describe(error)}`);
        log(`      failed after ${took()}: ${describe(error)}`);
      }
    }
  }
  return report;
}

/** Files one Entry and returns how many Items the model found in it, or null for a known Paper's new Version. */
async function fileEntry(entry: Entry, deps: RunDeps, report: RunReport): Promise<number | null> {
  const { profile, store, now } = deps;
  const version = { source: entry.source, url: entry.url, label: entry.paper?.versionLabel ?? entry.source, seenAt: now.toISOString() };

  // A Paper already in the archive gains a Version instead of a second assessment.
  if (entry.paper) {
    const existing = store.findPaper(entry.paper.doi, entry.title);
    if (existing !== null) {
      if (store.addVersion(existing, version)) {
        report.versionsAdded++;
        store.noteNewVersion(existing, profile.id, `now ${entry.paper.versionLabel}`);
      }
      return null;
    }
  }

  const assessed = await deps.assess(entry, store.recentVotes(profile.id, CALIBRATION_VOTES));
  report.entriesAssessed++;

  for (const raw of assessed) {
    const item = toNewItem(raw, entry);
    const existing =
      item.kind === "paper" ? store.findPaper(item.doi, item.title) : store.findOpportunity(item.kind, item.title, item.startsOn);
    const id = existing ?? store.insertItem(item, now);
    if (existing === null) report.itemsAdded++;
    else {
      report.itemsMerged++;
      store.fillGaps(existing, item);
    }
    store.addDeadlines(id, validDeadlines(raw.deadlines));
    store.addVersion(id, version);
    if (!store.hasJudgement(id, profile.id)) {
      const seriesShift = item.seriesKey ? Math.sign(store.seriesVote(profile.id, item.seriesKey)) * SERIES_VOTE_SHIFT : 0;
      store.saveJudgement(id, profile.id, clampScore(raw.score + seriesShift), [...new Set(raw.topics)]);
    }
  }
  return assessed.length;

  function toNewItem(raw: AssessedItem, from: Entry): NewItem {
    const kind: Kind = from.paper ? "paper" : raw.kind;
    return {
      kind,
      title: from.paper ? from.title : raw.title.trim() || from.title,
      summary: raw.summary.trim(),
      abstract: from.paper ? from.text : raw.description.trim(),
      language: raw.language,
      url: from.url,
      doi: from.paper?.doi ?? null,
      keynotes: raw.keynotes,
      location: isEvent(kind) ? raw.location : null,
      startsOn: isoDate(raw.startsOn),
      endsOn: isoDate(raw.endsOn),
      seriesKey: isEvent(kind) ? seriesKeyFor(raw.title) || null : null,
      callForEventId: kind === "call" && raw.callForEvent ? store.findEventByTitle(raw.callForEvent) : null,
    };
  }
}

/**
 * One line per feed and page saying whether it can be read, for checking a new address before a collect
 * run. Reads only; nothing is assessed or stored.
 */
export async function checkSources(sources: SourcesConfig, fetch: Fetch, now: Date): Promise<string[]> {
  const feeds = sources.feeds.map(async (feed) => {
    if (feed.enabled === false) return off(feed.name);
    try {
      const entries = await readFeed(feed, fetch);
      if (entries.length === 0) return `?  ${feed.name}: no posts found; the address may be a web page rather than a feed`;
      const newest = entries.map((e) => e.publishedAt ?? "").sort().at(-1)?.slice(0, 10);
      return `✓  ${feed.name}: ${entries.length} posts${newest ? `, newest ${newest}` : ""}`;
    } catch (error) {
      return `✗  ${feed.name}: ${describe(error)}`;
    }
  });
  const pages = sources.pages.map(async (page) => {
    if (page.enabled === false) return off(page.name);
    try {
      const [entry] = await readPage(page, fetch, now);
      if (!entry || entry.text.length < 200) return `?  ${page.name}: almost no text; the page may need a browser to show its content`;
      return `✓  ${page.name}: ${entry.text.length} characters, "${entry.title.slice(0, 60)}"`;
    } catch (error) {
      return `✗  ${page.name}: ${describe(error)}`;
    }
  });
  return Promise.all([...feeds, ...pages]);
}

function off(name: string): string {
  return `–  ${name}: switched off ("enabled": false)`;
}

/** fetch() reports network trouble as "fetch failed" with the real reason in `cause`. */
function describe(error: unknown): string {
  const { message, cause } = error as Error & { cause?: { code?: string; message?: string } };
  const reason = cause?.code ?? cause?.message;
  return reason ? `${message} (${reason})` : message;
}

export function clampScore(score: number): number {
  return Math.max(-10, Math.min(10, Math.round(score)));
}

function isoDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function validDeadlines(deadlines: AssessedItem["deadlines"]): Deadline[] {
  return deadlines.flatMap((d) => {
    const at = new Date(d.at);
    return Number.isNaN(at.getTime()) ? [] : [{ label: d.label, type: d.type, at: at.toISOString(), original: d.original }];
  });
}
