import assert from "node:assert/strict";
import { test } from "node:test";
import { StopRun } from "../src/assess.ts";
import { checkSources, collect, type RunDeps } from "../src/radar.ts";
import { Store } from "../src/store.ts";
import { fakeAssessor, fakeFetch, fixture, item, NOW, testProfile, testSources } from "./helpers.ts";

const BLOG = { id: "blog", name: "Test Blog", url: "https://blog.example/feed/" };
const ANNOUNCEMENTS = "Announcements: ESIL 2027 Annual Conference; RCSL panel call";
const PAPER = "Commissions of Inquiry and International Law";

const esil2027 = item({
  kind: "conference",
  title: "ESIL 2027 Annual Conference",
  score: 7,
  startsOn: "2027-09-09",
  endsOn: "2027-09-11",
  location: { city: "Leiden", country: "Netherlands", mode: "in_person" },
  keynotes: ["Jane Doe"],
  deadlines: [{ label: "Abstract submission", type: "submission", at: "2027-01-15T22:59:00Z", original: "15 January 2027 (23:59 CET)" }],
});
const rcslCall = item({ kind: "call", title: "RCSL panel at LSA 2027", score: 6, callForEvent: "LSA 2027 Annual Meeting", topics: ["Computational law"] });

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    profile: testProfile(),
    sources: testSources([BLOG]),
    store: new Store(":memory:"),
    assess: fakeAssessor({ [ANNOUNCEMENTS]: [esil2027, rcslCall], [PAPER]: [item({ title: PAPER, score: 8 })] }),
    fetch: fakeFetch({ "https://api.openalex.org/": fixture("openalex.json"), "https://blog.example/feed/": fixture("blog.rss.xml") }),
    now: NOW,
    ...overrides,
  };
}

test("an announcements post yields one Item per opportunity, and commentary yields none", async () => {
  const d = deps();
  const report = await collect(d);
  assert.deepEqual(report.failures, []);
  assert.equal(report.entriesAssessed, 3);
  assert.equal(report.itemsAdded, 3);

  const items = d.store.items("arthur");
  const conference = items.find((i) => i.kind === "conference")!;
  assert.equal(conference.seriesKey, "esil annual conference");
  assert.deepEqual(conference.location, { city: "Leiden", country: "Netherlands", mode: "in_person" });
  assert.deepEqual(conference.keynotes, ["Jane Doe"]);
  assert.equal(conference.deadlines[0]!.at, "2027-01-15T22:59:00.000Z");
  assert.equal(conference.score, 7);

  const paper = items.find((i) => i.kind === "paper")!;
  assert.equal(paper.doi, "10.1017/iclq.2026.1");
  assert.equal(paper.abstract, "Commissions of inquiry matter.");
  assert.equal(paper.versions.length, 1);
});

test("Entries already read are not assessed again", async () => {
  const d = deps();
  await collect(d);
  const again = await collect({ ...d, assess: fakeAssessor({}) });
  assert.equal(again.entriesAssessed, 0);
  assert.equal(d.store.items("arthur").length, 3);
});

test("a later Version of a Paper joins the existing Item and is noted only if saved", async () => {
  const d = deps({ sources: testSources([]) });
  await collect(d);
  const [paper] = d.store.items("arthur");
  d.store.setStatus(paper!.id, "arthur", "saved");

  const published = fixture("openalex.json")
    .replace('"https://openalex.org/W1"', '"https://openalex.org/W9"')
    .replace('"preprint"', '"article"')
    .replace('"https://ssrn.example/1"', '"https://journal.example/iclq"')
    .replace('"SSRN"', '"International and Comparative Law Quarterly"');
  const assess = fakeAssessor({});
  const report = await collect({ ...d, assess, fetch: fakeFetch({ "https://api.openalex.org/": published }) });

  assert.equal(report.versionsAdded, 1);
  assert.deepEqual(assess.seen, [], "a known Paper is not reassessed");
  const [after] = d.store.items("arthur");
  assert.equal(after!.versions.length, 2);
  assert.equal(after!.versionNote, "now International and Comparative Law Quarterly");
});

test("a 👍 on one edition lifts the next edition of the Series", async () => {
  const d = deps({ sources: testSources([BLOG]) });
  d.sources.openalex.enabled = false;
  const store = d.store;
  const id2026 = store.insertItem(
    { kind: "conference", title: "18th ESIL Annual Conference (2026)", summary: "", abstract: "", language: "en", url: "u", doi: null, keynotes: [], location: null, startsOn: "2026-09-01", endsOn: null, seriesKey: "esil annual conference", callForEventId: null },
    NOW,
  );
  store.saveJudgement(id2026, "arthur", 5, []);
  store.setVote(id2026, "arthur", 1, NOW);
  store.setDismissed(id2026, "arthur", true);

  await collect(d);
  const esil = store.items("arthur").find((i) => i.title === "ESIL 2027 Annual Conference")!;
  assert.equal(esil.score, 9, "7 from the model, +2 for the Series 👍");
  assert.equal(esil.dismissed, false, "Dismissed does not carry over");
});

test("the model sees recent Votes as calibration", async () => {
  const d = deps({ sources: testSources([]) });
  const store = d.store;
  const id = store.insertItem(
    { kind: "paper", title: "Old paper", summary: "", abstract: "", language: "en", url: "u", doi: null, keynotes: [], location: null, startsOn: null, endsOn: null, seriesKey: null, callForEventId: null },
    NOW,
  );
  store.saveJudgement(id, "arthur", 3, []);
  store.setVote(id, "arthur", -1, NOW);
  const assess = fakeAssessor({});
  await collect({ ...d, assess });
  assert.deepEqual(assess.calibration, [1]);
});

test("--limit defers new Entries to the next run", async () => {
  const d = deps({ limitPerSource: 1 });
  const report = await collect(d);
  assert.equal(report.entriesAssessed, 2, "one from OpenAlex, one from the blog");
  assert.equal(report.entriesDeferred, 1);
  const next = await collect({ ...d, limitPerSource: undefined });
  assert.equal(next.entriesAssessed, 1);
});

test("a failing Source is reported without stopping the others", async () => {
  const d = deps({ fetch: fakeFetch({ "https://blog.example/feed/": fixture("blog.rss.xml") }) });
  const report = await collect(d);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]!, /^OpenAlex: OpenAlex returned 404/);
  assert.equal(report.itemsAdded, 2);
});

test("a failed assessment leaves the Entry unseen so the next run retries it", async () => {
  const d = deps({ sources: testSources([]) });
  const report = await collect({ ...d, assess: async () => Promise.reject(new Error("rate limited")) });
  assert.equal(report.failures.length, 1);
  const retry = await collect(d);
  assert.equal(retry.itemsAdded, 1);
});

test("the same Event from two Sources is merged into one Item", async () => {
  const d = deps({ sources: testSources([BLOG, { ...BLOG, id: "mirror", name: "Mirror", url: "https://mirror.example/feed/" }]) });
  d.sources.openalex.enabled = false;
  d.fetch = fakeFetch({ "https://blog.example/feed/": fixture("blog.rss.xml"), "https://mirror.example/feed/": fixture("blog.rss.xml") });
  const report = await collect(d);
  assert.equal(report.itemsAdded, 2);
  assert.equal(report.itemsMerged, 2);
  const conference = d.store.items("arthur").find((i) => i.kind === "conference")!;
  assert.equal(conference.versions.length, 1, "same URL, so one Version");
  assert.equal(conference.deadlines.length, 1, "identical Deadlines are not duplicated");
});

test("a StopRun ends the run at once and leaves every Entry for next time", async () => {
  const d = deps();
  let calls = 0;
  const report = await collect({ ...d, assess: async () => (calls++, Promise.reject(new StopRun("no credit"))) });
  assert.equal(calls, 1);
  assert.equal(report.stopped, "no credit");
  assert.deepEqual(report.failures, []);
  const next = await collect(d);
  assert.equal(next.entriesAssessed, 3);
});

test("the log names each Entry before it is assessed, then what it yielded, and reports a failing Source at once", async () => {
  const lines: string[] = [];
  const d = deps({ fetch: fakeFetch({ "https://blog.example/feed/": fixture("blog.rss.xml") }), log: (line) => lines.push(line) });
  await collect(d);
  assert.match(lines[0]!, /^OpenAlex: couldn't read it \(OpenAlex returned 404/);
  assert.equal(lines[1], "Test Blog: 2 entries, 2 new");
  assert.equal(lines[2], `  1/2 ${ANNOUNCEMENTS}`);
  assert.match(lines[3]!, /^      2 Items in \d+s$/);
  assert.match(lines[5]!, /^      0 Items in \d+s$/);
});

test("a switched-off feed is not read", async () => {
  const d = deps({ sources: testSources([{ ...BLOG, enabled: false }]) });
  d.sources.openalex.enabled = false;
  const report = await collect(d);
  assert.equal(report.entriesRead, 0);
});


test("a page Source is collected like a feed, and the prompt says it is a page", async () => {
  const PAGE = { id: "asli", name: "ASLI conference", url: "https://law.example/call.html" };
  const call = item({ kind: "conference", title: "24th Asian Law Institute Conference", score: 8 });
  const d = deps({
    sources: { ...testSources([]), pages: [PAGE] },
    fetch: fakeFetch({ [PAGE.url]: fixture("call.html") }),
    assess: fakeAssessor({ "Call for Papers: 24th Asian Law Institute Conference": [call] }),
  });
  d.sources.openalex.enabled = false;
  const report = await collect(d);

  assert.deepEqual(report.failures, []);
  assert.equal(report.itemsAdded, 1);
  assert.equal(d.store.items("arthur")[0]!.url, PAGE.url);

  const again = await collect({ ...d, assess: fakeAssessor({}) });
  assert.equal(again.entriesAssessed, 0, "an unchanged page is not read again");
});

test("checking Sources reports feeds, pages, web pages mistaken for feeds, failures and switched-off entries", async () => {
  const fetch = fakeFetch({
    "https://blog.example/feed/": fixture("blog.rss.xml"),
    "https://page.example/": "<html><body>Hello</body></html>",
    "https://law.example/call.html": fixture("call.html"),
  });
  const sources = {
    ...testSources([BLOG, { id: "page", name: "Page", url: "https://page.example/" }, { id: "gone", name: "Gone", url: "https://gone.example/feed/" }]),
    pages: [
      { id: "asli", name: "ASLI", url: "https://law.example/call.html" },
      { id: "thin", name: "Thin", url: "https://page.example/" },
      { id: "wechat", name: "WeChat", url: "http://localhost:4000/feeds/all.atom", enabled: false },
    ],
  };
  const lines = await checkSources(sources, fetch, NOW);

  assert.match(lines[0]!, /^✓  Test Blog: 2 posts, newest 2026-10-/);
  assert.match(lines[1]!, /^\?  Page: no posts found/);
  assert.match(lines[2]!, /^✗  Gone: Gone returned 404/);
  assert.match(lines[3]!, /^✓  ASLI: \d+ characters, "Call for Papers: 24th Asian Law/);
  assert.match(lines[4]!, /^\?  Thin: almost no text/);
  assert.match(lines[5]!, /^–  WeChat: switched off/);
});
