/**
 * Reads recent Papers from OpenAlex (https://docs.openalex.org), one search per Topic query.
 * Searches are billed against a small free daily allowance, which a free API key raises tenfold.
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
    source: {
      display_name: string | null;
      type?: string | null;
      /** Every work in the venue is open access. */
      is_oa?: boolean | null;
      /** Listed in the Directory of Open Access Journals, which vets open-access journals. */
      is_in_doaj?: boolean | null;
      /** On the CWTS core list of established sources behind the Leiden Ranking. */
      is_core?: boolean | null;
    } | null;
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
    const inSubfields = config.subfields.length > 0 ? `,topics.subfield.id:${config.subfields.join("|")}` : "";
    url.searchParams.set("filter", `from_publication_date:${since}${inSubfields}`);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", String(config.perQuery));
    if (config.mailto) url.searchParams.set("mailto", config.mailto);
    if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
    const res = await fetch(url.toString());
    if (res.status === 429) {
      throw new Error(
        config.apiKey
          ? `OpenAlex's daily allowance for your key is used up (429); Papers are read again on the next run`
          : `OpenAlex's daily allowance without a key is used up (429). A free key raises it tenfold: see "OpenAlex key" in the README`,
      );
    }
    if (!res.ok) throw new Error(`OpenAlex returned ${res.status} for "${query}"`);
    const body = JSON.parse(await res.text()) as { results: OpenAlexWork[] };
    for (const work of body.results) {
      const entry = toEntry(work, config.excludeVenues, config.skipUnvettedOpenAccessJournals);
      if (entry) byId.set(entry.entryId, entry);
    }
  }
  return [...byId.values()];
}

function toEntry(work: OpenAlexWork, excludeVenues: string[], skipUnvetted: boolean): Entry | null {
  if (!work.display_name || (work.type && !WANTED_TYPES.has(work.type))) return null;
  const doi = work.doi ? work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null;
  const venue = work.primary_location?.source?.display_name ?? null;
  // A work with no known venue is almost always an uploaded file with nothing vouching for it.
  if (!venue || isExcludedVenue(venue, excludeVenues)) return null;
  if (skipUnvetted && isUnvettedOpenAccessJournal(work.primary_location!.source!)) return null;
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

/**
 * The mark of a likely predatory journal: fully open access, yet vetted neither by the DOAJ nor by the CWTS
 * core list. Subscription and hybrid journals, DOAJ journals and repositories such as SSRN are unaffected.
 */
export function isUnvettedOpenAccessJournal(source: NonNullable<NonNullable<OpenAlexWork["primary_location"]>["source"]>): boolean {
  return source.type === "journal" && source.is_oa === true && source.is_in_doaj === false && source.is_core !== true;
}

export function isExcludedVenue(venue: string, excludeVenues: string[]): boolean {
  const name = venue.toLowerCase();
  return excludeVenues.some((v) => name.includes(v.toLowerCase()));
}

/** The names OpenAlex gives the configured subfields, to confirm the ids mean what they are meant to. */
export async function subfieldNames(config: SourcesConfig["openalex"], fetch: Fetch): Promise<string[]> {
  return Promise.all(
    config.subfields.map(async (id) => {
      const res = await fetch(`https://api.openalex.org/subfields/${id}${config.apiKey ? `?api_key=${config.apiKey}` : ""}`);
      if (!res.ok) throw new Error(`OpenAlex has no subfield ${id} (${res.status})`);
      return String((JSON.parse(await res.text()) as { display_name: string }).display_name);
    }),
  );
}

/** OpenAlex ships abstracts as word → positions; put the words back in order. */
export function abstractFrom(index: Record<string, number[]> | null): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(" ");
}
