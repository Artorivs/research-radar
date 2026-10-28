/**
 * Reads recent Papers from OpenAlex (https://docs.openalex.org) in two ways: one search per Topic query,
 * and every new article in the journals the Sources list, whatever its wording.
 * Requests are billed against a small free daily allowance, which a free API key raises tenfold.
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
/**
 * Open-upload sites, where anyone can post anything. Their records sometimes reach OpenAlex under another
 * venue's name, so they are also caught by the DOI prefix the site issues and by the address of the record.
 */
const OPEN_UPLOAD_DOI_PREFIXES = ["10.5281/", "10.6084/", "10.31219/", "10.31234/", "10.31235/", "10.17605/", "10.20944/", "10.21203/", "10.32388/", "10.22541/", "10.36227/"];
const OPEN_UPLOAD_HOSTS = ["zenodo.org", "figshare.com", "osf.io", "researchgate.net", "academia.edu", "preprints.org", "researchsquare.com", "qeios.com", "authorea.com", "archive.org"];
/** Pages of 200 read from the watched journals per run; a month of 50 journals is well within it. */
const MAX_JOURNAL_PAGES = 10;

function worksUrl(config: SourcesConfig["openalex"]): URL {
  const url = new URL("https://api.openalex.org/works");
  if (config.mailto) url.searchParams.set("mailto", config.mailto);
  if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
  return url;
}

async function getWorks(
  url: URL,
  what: string,
  config: SourcesConfig["openalex"],
  fetch: Fetch,
): Promise<{ results: OpenAlexWork[]; meta?: { next_cursor?: string | null } }> {
  const res = await fetch(url.toString());
  if (res.status === 429) {
    throw new Error(
      config.apiKey
        ? `OpenAlex's daily allowance for your key is used up (429); Papers are read again on the next run`
        : `OpenAlex's daily allowance without a key is used up (429). A free key raises it tenfold: see "OpenAlex key" in the README`,
    );
  }
  if (!res.ok) throw new Error(`OpenAlex returned ${res.status} for ${what}`);
  return JSON.parse(await res.text());
}

export async function readOpenAlex(
  profile: Profile,
  config: SourcesConfig["openalex"],
  fetch: Fetch,
  now: Date,
): Promise<Entry[]> {
  if (!config.enabled) return [];
  const since = new Date(now.getTime() - config.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const byId = new Map<string, Entry>();
  const keep = (works: OpenAlexWork[], searched: boolean) => {
    for (const work of works) {
      const entry = toEntry(work, config, searched);
      if (entry) byId.set(entry.entryId, entry);
    }
  };

  for (const query of profile.topics.flatMap((t) => t.queries)) {
    const url = worksUrl(config);
    url.searchParams.set("search", query);
    // The main topic only: a paper on theatre or medicine often carries a minor topic in political science.
    const inSubfields = config.subfields.length > 0 ? `,primary_topic.subfield.id:${config.subfields.join("|")}` : "";
    url.searchParams.set("filter", `from_publication_date:${since}${inSubfields}`);
    url.searchParams.set("sort", "publication_date:desc");
    url.searchParams.set("per-page", String(config.perQuery));
    keep((await getWorks(url, `"${query}"`, config, fetch)).results, true);
  }

  // The journals were chosen by hand, so neither the subfield limit nor the vetting check applies.
  if (config.journals.length > 0) {
    let cursor: string | null = "*";
    for (let page = 0; cursor && page < MAX_JOURNAL_PAGES; page++) {
      const url = worksUrl(config);
      url.searchParams.set("filter", `from_publication_date:${since},primary_location.source.issn:${config.journals.map((j) => j.issn).join("|")}`);
      url.searchParams.set("per-page", "200");
      url.searchParams.set("cursor", cursor);
      const body = await getWorks(url, "the watched journals", config, fetch);
      keep(body.results, false);
      cursor = body.results.length > 0 ? (body.meta?.next_cursor ?? null) : null;
    }
  }
  return [...byId.values()];
}

/** A searched work must pass the vetting check; one from a watched journal was chosen by hand and need not. */
function toEntry(work: OpenAlexWork, config: SourcesConfig["openalex"], searched: boolean): Entry | null {
  if (!work.display_name || (work.type && !WANTED_TYPES.has(work.type))) return null;
  const doi = work.doi ? work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null;
  const source = work.primary_location?.source ?? null;
  const venue = source?.display_name ?? null;
  // A work with no known venue is almost always an uploaded file with nothing vouching for it.
  if (!source || !venue || namesAny(venue, config.excludeVenues)) return null;
  if (isOpenUpload(doi, work.primary_location?.landing_page_url ?? null)) return null;
  if (searched && config.onlyVettedVenues && !isVetted(source, config.trustedVenues)) return null;
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
 * Vouched for by someone who checks journals: the CWTS core list (the established journals behind the Leiden
 * Ranking) or the Directory of Open Access Journals, or named in trustedVenues (SSRN). Predatory journals,
 * open-upload sites and obscure venues fail this.
 */
export function isVetted(source: NonNullable<NonNullable<OpenAlexWork["primary_location"]>["source"]>, trustedVenues: string[]): boolean {
  return source.is_core === true || source.is_in_doaj === true || namesAny(source.display_name ?? "", trustedVenues);
}

function isOpenUpload(doi: string | null, landingPage: string | null): boolean {
  if (doi && OPEN_UPLOAD_DOI_PREFIXES.some((p) => doi.startsWith(p))) return true;
  const host = landingPage ? URL.parse(landingPage)?.hostname.replace(/^www\./, "") : undefined;
  return host !== undefined && OPEN_UPLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Whether the venue name contains any of these words, ignoring case. */
export function namesAny(venue: string, words: string[]): boolean {
  const name = venue.toLowerCase();
  return words.some((v) => name.includes(v.toLowerCase()));
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

/**
 * How each watched journal's ISSN resolves in OpenAlex: its name there, or null when OpenAlex doesn't know
 * the ISSN. Single-record lookups like these are free, but OpenAlex limits how many arrive each second, so
 * they go one at a time and a refusal (429) is retried after a pause.
 */
export async function journalNames(
  config: SourcesConfig["openalex"],
  fetch: Fetch,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Array<{ name: string; issn: string; found: string | null }>> {
  const checked = [];
  for (const j of config.journals) {
    const url = `https://api.openalex.org/sources/issn:${j.issn}${config.apiKey ? `?api_key=${config.apiKey}` : ""}`;
    let res = await fetch(url);
    for (let retry = 1; res.status === 429 && retry <= 3; retry++) {
      await pause(1000 * retry);
      res = await fetch(url);
    }
    if (res.status === 404) checked.push({ ...j, found: null });
    else if (!res.ok) throw new Error(`OpenAlex returned ${res.status} for ISSN ${j.issn}`);
    else checked.push({ ...j, found: String((JSON.parse(await res.text()) as { display_name: string }).display_name) });
  }
  return checked;
}

/** OpenAlex ships abstracts as word → positions; put the words back in order. */
export function abstractFrom(index: Record<string, number[]> | null): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(" ");
}
