import assert from "node:assert/strict";
import { test } from "node:test";
import { withOpenAlexKey } from "../src/config.ts";
import type { Fetch } from "../src/sources/entry.ts";
import { parseFeed } from "../src/sources/feed.ts";
import { abstractFrom, readOpenAlex } from "../src/sources/openalex.ts";
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

test("OpenAlex works become Paper Entries, skipping datasets", async () => {
  const fetch = fakeFetch({ "https://api.openalex.org/works": fixture("openalex.json") });
  const entries = await readOpenAlex(testProfile(), testSources().openalex, fetch, NOW);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.paper, { doi: "10.1017/iclq.2026.1", venue: "SSRN", versionLabel: "Preprint (SSRN)" });
  assert.equal(entries[0]!.text, "Commissions of inquiry matter.");
  const asked = new URL(fetch.calls[0]!);
  assert.equal(asked.searchParams.get("search"), "international law");
  assert.equal(asked.searchParams.get("filter"), "from_publication_date:2026-09-24");
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

test("abstracts are rebuilt from OpenAlex's inverted index", () => {
  assert.equal(abstractFrom({ law: [1], International: [0], matters: [2] }), "International law matters");
  assert.equal(abstractFrom(null), "");
});
