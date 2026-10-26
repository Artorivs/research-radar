import assert from "node:assert/strict";
import { test } from "node:test";
import { withOpenAlexKey } from "../src/config.ts";
import type { Fetch } from "../src/sources/entry.ts";
import { parseFeed } from "../src/sources/feed.ts";
import { pageEntry, readPage } from "../src/sources/page.ts";
import { abstractFrom, journalNames, readOpenAlex } from "../src/sources/openalex.ts";
import { fakeFetch, fixture, NOW, testProfile, testSources } from "./helpers.ts";

test("RSS posts become Entries with markup stripped", () => {
  const entries = parseFeed("blog", fixture("blog.rss.xml"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.entryId, "https://blog.example/?p=101");
  assert.equal(entries[0]!.publishedAt, "2026-10-19T08:00:00.000Z");
  assert.match(entries[0]!.text, /Leiden, 9–11 September 2027/);
  assert.doesNotMatch(entries[0]!.text, /<strong>/);
  assert.equal(entries[1]!.title, "The ICJ’s advisory opinion: a comment");
  assert.equal(entries[1]!.text, "Some thoughts on the opinion.");
});

test("Atom entries become Entries", () => {
  const [entry] = parseFeed("atom", fixture("blog.atom.xml"));
  assert.equal(entry!.url, "https://atom.example/cfp");
  assert.equal(entry!.title, "Call for Papers: Verfassungsgerichte im Wandel");
  assert.equal(entry!.text, "Beiträge bis 31. März 2027.");
});

test("OpenAlex works become Paper Entries, skipping datasets, excluded venues such as Zenodo, and works with no venue", async () => {
  const fetch = fakeFetch({ "https://api.openalex.org/works": fixture("openalex.json") });
  const entries = await readOpenAlex(testProfile(), testSources().openalex, fetch, NOW);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.paper, { doi: "10.1017/iclq.2026.1", venue: "SSRN", versionLabel: "Preprint (SSRN)" });
  assert.equal(entries[0]!.text, "Commissions of inquiry matter.");
  const asked = new URL(fetch.calls[0]!);
  assert.equal(asked.searchParams.get("search"), "international law");
  assert.equal(asked.searchParams.get("filter"), "from_publication_date:2026-09-24,topics.subfield.id:3308");
});

test("fully open-access journals that neither the DOAJ nor the CWTS core list vouches for are skipped", async () => {
  const work = (id: string, source: Record<string, unknown>) => ({
    id, doi: null, display_name: `Paper ${id}`, publication_date: "2026-10-05", type: "article", abstract_inverted_index: null,
    primary_location: { landing_page_url: `https://example.org/${id}`, source: { display_name: `Venue ${id}`, ...source } },
  });
  const body = JSON.stringify({
    results: [
      work("predatory", { type: "journal", is_oa: true, is_in_doaj: false, is_core: false }),
      work("doaj", { type: "journal", is_oa: true, is_in_doaj: true, is_core: false }),
      work("subscription", { type: "journal", is_oa: false, is_in_doaj: false, is_core: false }),
      work("core-oa", { type: "journal", is_oa: true, is_in_doaj: false, is_core: true }),
      work("ssrn", { type: "repository", is_oa: true, is_in_doaj: false, is_core: false }),
      work("no-flags", {}),
    ],
  });
  const fetch = fakeFetch({ "https://api.openalex.org/works": body });
  const kept = (await readOpenAlex(testProfile(), testSources().openalex, fetch, NOW)).map((e) => e.title);
  assert.deepEqual(kept.sort(), ["Paper core-oa", "Paper doaj", "Paper no-flags", "Paper ssrn", "Paper subscription"]);

  const all = await readOpenAlex(testProfile(), { ...testSources().openalex, skipUnvettedOpenAccessJournals: false }, fetch, NOW);
  assert.equal(all.length, 6);
});

test("an OpenAlex key from .env is sent with each search, and a used-up allowance says how to fix it", async () => {
  const fetch = fakeFetch({ "https://api.openalex.org/works": fixture("openalex.json") });
  const sources = withOpenAlexKey(testSources(), "k123");
  await readOpenAlex(testProfile(), sources.openalex, fetch, NOW);
  assert.equal(new URL(fetch.calls[0]!).searchParams.get("api_key"), "k123");
  assert.equal(withOpenAlexKey(testSources(), undefined).openalex.apiKey, undefined);

  const limited: Fetch = async () => ({ ok: false, status: 429, text: async () => "" });
  await assert.rejects(readOpenAlex(testProfile(), testSources().openalex, limited, NOW), /without a key is used up \(429\).*README/);
  await assert.rejects(readOpenAlex(testProfile(), sources.openalex, limited, NOW), /for your key is used up/);
});

test("several subfields are joined as alternatives, and none means no limit", async () => {
  const fetch = fakeFetch({ "https://api.openalex.org/works": fixture("openalex.json") });
  await readOpenAlex(testProfile(), { ...testSources().openalex, subfields: [3308, 3320] }, fetch, NOW);
  assert.equal(new URL(fetch.calls[0]!).searchParams.get("filter"), "from_publication_date:2026-09-24,topics.subfield.id:3308|3320");
  await readOpenAlex(testProfile(), { ...testSources().openalex, subfields: [] }, fetch, NOW);
  assert.equal(new URL(fetch.calls.at(-1)!).searchParams.get("filter"), "from_publication_date:2026-09-24");
});

test("every new article in the watched journals is read, page by page, without the subfield or vetting filters", async () => {
  const work = (id: string) => ({
    id, doi: null, display_name: `Article ${id}`, publication_date: "2026-10-05", type: "article", abstract_inverted_index: null,
    primary_location: { landing_page_url: `https://example.org/${id}`, source: { display_name: "German Law Journal", type: "journal", is_oa: true, is_in_doaj: false, is_core: false } },
  });
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    const cursor = new URL(url).searchParams.get("cursor");
    if (cursor === null) return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    const body = cursor === "*" ? { results: [work("a"), work("b")], meta: { next_cursor: "page2" } } : cursor === "page2" ? { results: [work("c")], meta: { next_cursor: "page3" } } : { results: [], meta: { next_cursor: null } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const config = { ...testSources().openalex, journals: [{ name: "German Law Journal", issn: "2071-8322" }, { name: "Der Staat", issn: "0038-884X" }] };
  const entries = await readOpenAlex(testProfile(), config, fetch, NOW);

  assert.deepEqual(entries.map((e) => e.title).sort(), ["Article a", "Article b", "Article c"], "kept although unvetted by DOAJ or CWTS");
  const journalCalls = calls.filter((u) => new URL(u).searchParams.has("cursor")).map((u) => new URL(u));
  assert.equal(journalCalls[0]!.searchParams.get("filter"), "from_publication_date:2026-09-24,primary_location.source.issn:2071-8322|0038-884X");
  assert.equal(journalCalls[0]!.searchParams.get("search"), null);
  assert.deepEqual(journalCalls.map((u) => u.searchParams.get("cursor")), ["*", "page2", "page3"]);
});

test("journal ISSNs are looked up one at a time, waiting and retrying when OpenAlex says too many (429)", async () => {
  let inFlight = 0;
  let mostAtOnce = 0;
  let refusals = 1;
  const fetch: Fetch = async (url) => {
    mostAtOnce = Math.max(mostAtOnce, ++inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    if (url.includes("0038-884X") && refusals-- > 0) return { ok: false, status: 429, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ display_name: url.includes("0038-884X") ? "Der Staat" : "German Law Journal" }) };
  };
  const pauses: number[] = [];
  const config = { ...testSources().openalex, journals: [{ name: "German Law Journal", issn: "2071-8322" }, { name: "Der Staat", issn: "0038-884X" }] };
  const names = await journalNames(config, fetch, async (ms) => void pauses.push(ms));

  assert.deepEqual(names.map((j) => j.found), ["German Law Journal", "Der Staat"]);
  assert.equal(mostAtOnce, 1);
  assert.deepEqual(pauses, [1000]);
});

test("abstracts are rebuilt from OpenAlex's inverted index", () => {
  assert.equal(abstractFrom({ law: [1], International: [0], matters: [2] }), "International law matters");
  assert.equal(abstractFrom(null), "");
});

const ASLI = { id: "asli", name: "Asian Law Institute conference", url: "https://law.example/asli/call_for_papers.html" };

test("a web page becomes one Entry, titled by its heading, without menus or footer", async () => {
  const fetch = fakeFetch({ [ASLI.url]: fixture("call.html") });
  const [entry] = await readPage(ASLI, fetch, NOW);

  assert.equal(entry!.title, "Call for Papers: 24th Asian Law Institute Conference");
  assert.equal(entry!.kind, "page");
  assert.equal(entry!.source, "asli");
  assert.equal(entry!.publishedAt, NOW.toISOString());
  assert.match(entry!.text, /Abstracts of no more than 500 words should be submitted by 15 December 2026/);
  assert.match(entry!.text, /28–29 May 2027/, "entities are decoded");
  assert.doesNotMatch(entry!.text, /Home|About the Institute|All rights reserved/);
  assert.doesNotMatch(entry!.text, /24th ASLI Conference \|/, "the <title> is not repeated in the text");
});

test("a page is one Entry while its text holds, and a new Entry once the text changes", () => {
  const html = fixture("call.html");
  assert.equal(pageEntry(ASLI, html, NOW).entryId, pageEntry(ASLI, html, new Date("2027-01-01T00:00:00Z")).entryId);
  const later = html.replace("15 December 2026", "31 January 2027");
  assert.notEqual(pageEntry(ASLI, later, NOW).entryId, pageEntry(ASLI, html, NOW).entryId);
  assert.match(pageEntry(ASLI, html, NOW).entryId, /^https:\/\/law\.example\/asli\/call_for_papers\.html#[0-9a-f]{16}$/);
});
