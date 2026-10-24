/**
 * Reads recent Papers from OpenAlex (https://docs.openalex.org), one search per Topic query.
 */
import type { Profile, SourcesConfig } from "../config.ts";
import type { Entry, Fetch } from "./entry.ts";

interface OpenAlexWork {
  id: string;
  doi: string | null;
  display_name: string | null;
  publication_date: string | null;
  type: string | null;
  abstract_inverted_index: Record<string, number[]> | null;
  primary_location: {
    landing_page_url: string | null;
    source: { display_name: string | null } | null;
  } | null;
}

const WANTED_TYPES = new Set(["article", "preprint", "book-chapter", "review", "report"]);

export async function readOpenAlex(
  profile: Profile,
  config: SourcesConfig["openalex"],
  fetch: Fetch,
  now: Date,
): Promise<Entry[]> {
  if (!config.enabled) return [];
  const since = new Date(now.getTime() - config.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const byId = new Map<string, Entry>();
  for (const query of profile.topics.flatMap((t) => t.queries)) {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("filter", `from_publication_date:${since}`);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", String(config.perQuery));
    if (config.mailto) url.searchParams.set("mailto", config.mailto);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`OpenAlex returned ${res.status} for "${query}"`);
    const body = JSON.parse(await res.text()) as { results: OpenAlexWork[] };
    for (const work of body.results) {
      const entry = toEntry(work);
      if (entry) byId.set(entry.entryId, entry);
    }
  }
  return [...byId.values()];
}

function toEntry(work: OpenAlexWork): Entry | null {
  if (!work.display_name || (work.type && !WANTED_TYPES.has(work.type))) return null;
  const doi = work.doi ? work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null;
  const venue = work.primary_location?.source?.display_name ?? null;
  return {
    source: "openalex",
    entryId: work.id,
    url: work.primary_location?.landing_page_url ?? work.doi ?? work.id,
    title: work.display_name,
    text: abstractFrom(work.abstract_inverted_index),
    publishedAt: work.publication_date,
    paper: {
      doi,
      venue,
      versionLabel: work.type === "preprint" ? `Preprint${venue ? ` (${venue})` : ""}` : (venue ?? "Published version"),
    },
  };
}

/** OpenAlex ships abstracts as word → positions; put the words back in order. */
export function abstractFrom(index: Record<string, number[]> | null): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(" ");
}
