import assert from "node:assert/strict";
import { test } from "node:test";
import { isPast, isValidStatus, nextSubmissionDeadline, seriesKeyFor, titleKey } from "../src/domain.ts";
import { NOW } from "./helpers.ts";

const deadline = (at: string, type: "submission" | "registration" = "submission") => ({ label: "x", type, at, original: at });

test("editions of an Event share a Series key", () => {
  assert.equal(seriesKeyFor("ESIL 2027 Annual Conference"), seriesKeyFor("18th ESIL Annual Conference (2026)"));
  assert.equal(seriesKeyFor("第十届 国际法论坛 2026"), seriesKeyFor("第十一届 国际法论坛 2027"));
  assert.notEqual(seriesKeyFor("ESIL Annual Conference"), seriesKeyFor("ASIL Annual Meeting"));
});

test("title keys ignore case, punctuation and spacing", () => {
  assert.equal(titleKey("Commissions of Inquiry: and International Law"), titleKey("commissions of inquiry and international law"));
});

test("an Event is Past once its last day is over", () => {
  const event = { kind: "conference" as const, startsOn: "2026-10-20", endsOn: "2026-10-24", deadlines: [] };
  assert.equal(isPast(event, NOW), false);
  assert.equal(isPast({ ...event, endsOn: "2026-10-23" }, NOW), true);
});

test("a Call is Past once every Submission deadline has gone, and a Paper never is", () => {
  const call = { kind: "call" as const, startsOn: null, endsOn: null, deadlines: [deadline("2026-10-01T00:00:00Z"), deadline("2026-11-01T00:00:00Z")] };
  assert.equal(isPast(call, NOW), false);
  assert.equal(isPast({ ...call, deadlines: [deadline("2026-10-01T00:00:00Z"), deadline("2026-12-01T00:00:00Z", "registration")] }, NOW), true);
  assert.equal(isPast({ ...call, kind: "paper" as const, deadlines: [deadline("2020-01-01T00:00:00Z")] }, NOW), false);
});

test("only Submission deadlines count as the next deadline", () => {
  const next = nextSubmissionDeadline(
    { deadlines: [deadline("2026-11-01T00:00:00Z", "registration"), deadline("2026-12-01T00:00:00Z"), deadline("2026-10-01T00:00:00Z")] },
    NOW,
  );
  assert.equal(next?.at, "2026-12-01T00:00:00Z");
});

test("Status values depend on Kind", () => {
  assert.ok(isValidStatus("paper", "read"));
  assert.ok(!isValidStatus("paper", "attending"));
  assert.ok(isValidStatus("conference", "attending"));
  assert.ok(isValidStatus("job", "applied"));
  assert.ok(!isValidStatus("job", "submitted"));
  assert.ok(isValidStatus("job", null));
});
