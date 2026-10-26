import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { claudeAssessor, DEFAULT_MODEL, StopRun, systemPrompt } from "../src/assess.ts";
import type { Entry } from "../src/sources/entry.ts";
import { item, testProfile } from "./helpers.ts";

const entry: Entry = {
  source: "blog",
  entryId: "1",
  url: "https://blog.example/1",
  title: "Call for papers",
  text: "Abstracts due 1 December 2026.",
  publishedAt: "2026-10-20T00:00:00Z",
  paper: null,
};

/** A stand-in for the SDK client that records the request and returns a canned response. */
function stubClient(response: Record<string, unknown>) {
  const requests: Array<Record<string, unknown>> = [];
  const client = { messages: { parse: async (req: Record<string, unknown>) => (requests.push(req), response) } };
  return { client: client as unknown as Anthropic, requests };
}

test("the system prompt carries the Profile's Topics, the rubric and Oxford spelling", () => {
  const prompt = systemPrompt(testProfile());
  assert.match(prompt, /- International law: Public international law/);
  assert.match(prompt, /- Adjacent:/);
  assert.match(prompt, /\+9 to \+10/);
  assert.match(prompt, /-ize endings/);
  assert.match(prompt, /Never call it a webinar/);
});

test("the assessor sends a cached system prompt, low effort and the Votes, and returns the parsed Items", async () => {
  const parsed = { items: [item({ kind: "call", title: "Call for papers" })] };
  const { client, requests } = stubClient({ stop_reason: "end_turn", parsed_output: parsed });
  const assess = claudeAssessor(testProfile(), client);
  const items = await assess(entry, [{ kind: "paper", title: "A paper I liked", vote: 1 }]);

  assert.deepEqual(items, parsed.items);
  const req = requests[0]!;
  assert.equal(req.model, DEFAULT_MODEL);
  assert.equal((req.output_config as { effort: string }).effort, "low");
  assert.deepEqual((req.system as Array<{ cache_control: unknown }>)[0]!.cache_control, { type: "ephemeral" });
  const user = (req.messages as Array<{ content: string }>)[0]!.content;
  assert.match(user, /👍 \[paper\] A paper I liked/);
  assert.match(user, /Feed Entry from blog/);
});

test("a web page Entry is announced as a page, so dates are read with care", async () => {
  const { client, requests } = stubClient({ stop_reason: "end_turn", parsed_output: { items: [] } });
  await claudeAssessor(testProfile(), client)({ ...entry, kind: "page" }, []);
  assert.match((requests[0]!.messages as Array<{ content: string }>)[0]!.content, /Web page from blog, read today/);
});

test("a refusal yields no Items rather than an error", async () => {
  const { client } = stubClient({ stop_reason: "refusal", stop_details: { category: null }, parsed_output: null });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await claudeAssessor(testProfile(), client)(entry, []), []);
  } finally {
    console.warn = warn;
  }
});

test("a truncated response is an error, so the Entry is retried next run", async () => {
  const { client } = stubClient({ stop_reason: "max_tokens", parsed_output: null });
  await assert.rejects(claudeAssessor(testProfile(), client)(entry, []), /cut off/);
});

test("an empty credit balance or a bad key stops the run instead of failing every Entry", async () => {
  const failing = (error: Error) => ({ messages: { parse: async () => Promise.reject(error) } }) as unknown as Anthropic;
  const credit = new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", new Headers());
  await assert.rejects(claudeAssessor(testProfile(), failing(credit))(entry, []), (e: Error) => e instanceof StopRun && /credit balance/.test(e.message));
  const key = new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers());
  await assert.rejects(claudeAssessor(testProfile(), failing(key))(entry, []), StopRun);
  const other = new Anthropic.BadRequestError(400, undefined, "prompt is too long", new Headers());
  await assert.rejects(claudeAssessor(testProfile(), failing(other))(entry, []), (e: Error) => !(e instanceof StopRun));
});
