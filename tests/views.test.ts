import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Item } from "../src/domain.ts";
import { startServer } from "../src/server.ts";
import { Store, type NewItem } from "../src/store.ts";
import { deadlinesCalendar, meetsThreshold } from "../src/views.ts";
import { NOW, testProfile } from "./helpers.ts";

function anItem(overrides: Partial<Item>): Item {
  return {
    id: 1, kind: "call", title: "Special issue on public inquiries", summary: "S.", abstract: "", language: "en", topics: [], score: 3,
    url: "https://x.example", doi: null, keynotes: [], location: null, startsOn: null, endsOn: null, seriesKey: null, callForEventId: null,
    deadlines: [], versions: [], status: null, dismissed: false, vote: null, versionNote: null, firstSeenAt: NOW.toISOString(),
    ...overrides,
  };
}
const open = { label: "Abstracts", type: "submission" as const, at: "2026-12-01T22:59:00Z", original: "1 December 2026, 23:59 CET" };

test("an open Submission deadline lowers the bar from +4 to +2", () => {
  const profile = testProfile();
  assert.equal(meetsThreshold(anItem({ score: 3 }), profile, NOW), false);
  assert.equal(meetsThreshold(anItem({ score: 3, deadlines: [open] }), profile, NOW), true);
  assert.equal(meetsThreshold(anItem({ score: 1, deadlines: [open] }), profile, NOW), false);
});

test("the calendar holds upcoming Submission deadlines of saved or relevant Items, with a 14-day reminder", () => {
  const profile = testProfile();
  const ics = deadlinesCalendar(
    [
      anItem({ id: 1, score: 3, deadlines: [open, { ...open, type: "registration", at: "2026-11-01T00:00:00Z" }] }),
      anItem({ id: 2, score: -5, deadlines: [open] }),
      anItem({ id: 3, score: -5, status: "saved", deadlines: [open] }),
      anItem({ id: 4, score: 9, dismissed: true, deadlines: [open] }),
      anItem({ id: 5, score: 9, deadlines: [{ ...open, at: "2026-01-01T00:00:00Z" }] }),
    ],
    profile,
    NOW,
  );
  const uids = [...ics.matchAll(/UID:radar-(\d+)-/g)].map((m) => m[1]);
  assert.deepEqual(uids, ["1", "3"]);
  assert.match(ics, /DTSTART:20261201T225900Z/);
  assert.match(ics, /TRIGGER:-P14D/);
  assert.ok(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75), "lines are folded at 75 octets");
});

test("the dashboard API lists Items and records Status, Votes and dismissals", async () => {
  const store = new Store(":memory:");
  const profile = testProfile();
  const paper: NewItem = {
    kind: "paper", title: "国際法と調査委員会", summary: "S.", abstract: "", language: "ja", url: "u", doi: null, keynotes: [], location: null,
    startsOn: null, endsOn: null, seriesKey: null, callForEventId: null,
  };
  const id = store.insertItem(paper, NOW);
  store.saveJudgement(id, profile.id, 6, ["International law"]);
  const server = startServer(store, profile, 0, () => NOW);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  try {
    assert.equal((await post(`/api/items/${id}/status`, { status: "read" })).status, 200);
    assert.equal((await post(`/api/items/${id}/vote`, { vote: 1 })).status, 200);
    assert.equal((await post(`/api/items/${id}/status`, { status: "attending" })).status, 400, "not a Status for a Paper");
    assert.equal((await post(`/api/items/${id}/vote`, { vote: 5 })).status, 400);

    const body = (await (await fetch(`${base}/api/items`)).json()) as { items: Array<Item & { past: boolean }> };
    assert.equal(body.items[0]!.title, "国際法と調査委員会");
    assert.equal(body.items[0]!.status, "read");
    assert.equal(body.items[0]!.vote, 1);
    assert.equal(body.items[0]!.past, false);

    const page = await fetch(base + "/");
    assert.match(await page.text(), /<title>Research Radar<\/title>/);
    assert.match((await fetch(base + "/deadlines.ics")).headers.get("content-type") ?? "", /text\/calendar/);
  } finally {
    server.close();
  }
});
