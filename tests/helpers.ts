import { readFileSync } from "node:fs";
import type { AssessedItem, Assessor } from "../src/assess.ts";
import type { Profile, SourcesConfig } from "../src/config.ts";
import type { Fetch } from "../src/sources/entry.ts";

export const NOW = new Date("2026-10-24T12:00:00Z");

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function testProfile(): Profile {
  return {
    id: "arthur",
    name: "Arthur",
    email: "",
    timezone: "Europe/London",
    field: "Law",
    thresholds: { general: 4, withOpenDeadline: 2 },
    topics: [
      { name: "International law", description: "Public international law", queries: ["international law"] },
      { name: "Computational law", description: "AI and law", queries: [] },
    ],
    seeds: [],
  };
}

export function testSources(feeds: SourcesConfig["feeds"] = []): SourcesConfig {
  return { openalex: { enabled: true, mailto: "", lookbackDays: 30, perQuery: 25 }, feeds };
}

/** A fetch that answers from a table of URL prefixes; anything else is a 404. */
export function fakeFetch(routes: Record<string, string>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    return { ok: match !== undefined, status: match ? 200 : 404, text: async () => (match ? routes[match]! : "") };
  };
  return Object.assign(fn, { calls });
}

export function item(overrides: Partial<AssessedItem>): AssessedItem {
  return {
    kind: "paper",
    title: "Untitled",
    summary: "A summary. It matters.",
    description: "",
    language: "en",
    topics: ["International law"],
    score: 5,
    startsOn: null,
    endsOn: null,
    location: null,
    keynotes: [],
    deadlines: [],
    callForEvent: null,
    ...overrides,
  };
}

/** An Assessor that answers by Entry title and records what it was asked. */
export function fakeAssessor(byTitle: Record<string, AssessedItem[]>): Assessor & { seen: string[]; calibration: number[] } {
  const seen: string[] = [];
  const calibration: number[] = [];
  const fn: Assessor = async (entry, votes) => {
    seen.push(entry.title);
    calibration.push(votes.length);
    return byTitle[entry.title] ?? [];
  };
  return Object.assign(fn, { seen, calibration });
}
