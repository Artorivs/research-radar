import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { assessmentSchema, StopRun } from "../src/assess.ts";
import { joinStream, jsonSchemaFor, ollamaAssessor } from "../src/ollama.ts";
import { chooseAssessor } from "../src/provider.ts";
import type { Entry, Fetch } from "../src/sources/entry.ts";
import { item, testProfile } from "./helpers.ts";

const entry: Entry = {
  source: "blog",
  entryId: "1",
  url: "https://blog.example/1",
  title: "13th Annual Junior Scholars Conference",
  text: "Abstracts due 1 December 2026.",
  publishedAt: "2026-10-20T00:00:00Z",
  paper: null,
};

/** A fetch standing in for Ollama's /api/chat that records each request body. */
function ollama(reply: { status?: number; content?: string; raw?: string }) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: Fetch = async (_url, init) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    const status = reply.status ?? 200;
    return { ok: status < 400, status, text: async () => reply.raw ?? JSON.stringify({ message: { content: reply.content ?? "" } }) };
  };
  return { fetch, bodies };
}

test("the local model gets the shared prompts, a JSON Schema to follow, and a large enough context", async () => {
  const answer = { items: [item({ kind: "conference", title: "13th Annual Junior Scholars Conference" })] };
  const { fetch, bodies } = ollama({ content: JSON.stringify(answer) });
  const items = await ollamaAssessor(testProfile(), fetch, "qwen3:14b")({ ...entry, text: "x".repeat(30_000) }, []);

  assert.deepEqual(items, answer.items);
  const body = bodies[0]!;
  assert.equal(body.model, "qwen3:14b");
  assert.equal(body.stream, true);
  assert.equal(body.think, false);
  assert.equal((body.options as { num_ctx: number }).num_ctx, 16_384);
  assert.equal((body.options as { num_predict: number }).num_predict, 8_192, "a looping answer is cut short");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0]!.content, /Score: integer from -10 to \+10/);
  assert.ok(messages[1]!.content.length < 13_000, "long posts are cut to fit");
  assert.match(messages[1]!.content, /\[…cut\]$/);
  assert.equal((body.format as { type: string }).type, "object");
});

test("the Score is the only integer, and its schema is bounded to −10…+10", () => {
  const schema = jsonSchemaFor(assessmentSchema(testProfile())) as any;
  assert.equal(schema.$schema, undefined);
  const score = schema.properties.items.items.properties.score;
  assert.deepEqual([score.type, score.minimum, score.maximum], ["integer", -10, 10]);
  assert.deepEqual(schema.properties.items.items.properties.topics.items.enum, ["Adjacent", "International law", "Computational law"]);
});

test("an answer that isn't valid JSON, or doesn't fit the schema, fails that Entry only", async () => {
  await assert.rejects(ollamaAssessor(testProfile(), ollama({ content: "Sure! Here is" }).fetch)(entry, []), /wasn't valid JSON/);
  const wrongKind = JSON.stringify({ items: [{ ...item({}), kind: "webinar" }] });
  await assert.rejects(ollamaAssessor(testProfile(), ollama({ content: wrongKind }).fetch)(entry, []), (e: Error) => !(e instanceof StopRun) && /didn't match the schema/.test(e.message));
});

test("a missing model or a stopped Ollama stops the run with a fix", async () => {
  await assert.rejects(ollamaAssessor(testProfile(), ollama({ status: 404, raw: "{}" }).fetch, "qwen3:14b")(entry, []), (e: Error) => e instanceof StopRun && /ollama pull qwen3:14b/.test(e.message));
  const closed = await listen(() => {});
  closed.server.close();
  await assert.rejects(ollamaAssessor(testProfile(), fetch, "m", closed.url)(entry, []), (e: Error) => e instanceof StopRun && /isn't answering/.test(e.message));
});

test("a streamed answer is read in full over real HTTP", async () => {
  const answer = JSON.stringify({ items: [item({ kind: "call", title: "Special issue" })] });
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const pieces = [answer.slice(0, 40), answer.slice(40)];
    for (const content of pieces) res.write(JSON.stringify({ message: { role: "assistant", content }, done: false }) + "\n");
    res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
  });
  try {
    const items = await ollamaAssessor(testProfile(), fetch, "m", url)(entry, []);
    assert.equal(items[0]!.title, "Special issue");
  } finally {
    server.close();
  }
});

test("a request Ollama drops part-way fails that Entry only, without stopping the run", async () => {
  const { server, url } = await listen((req) => req.socket.destroy());
  try {
    await assert.rejects(ollamaAssessor(testProfile(), fetch, "m", url)(entry, []), (e: Error) => !(e instanceof StopRun) && /didn't finish/.test(e.message));
  } finally {
    server.close();
  }
});

test("an error reported mid-stream is surfaced", () => {
  assert.equal(joinStream('{"message":{"content":"{\\"a\\":"}}\n{"message":{"content":"1}"}}\n'), '{"a":1}');
  assert.throws(() => joinStream('{"error":"model runner has unexpectedly stopped"}\n'), /unexpectedly stopped/);
  assert.throws(() => joinStream('{"message":{"content":"{\\"a\\":"}}\n{"done":true,"done_reason":"length"}\n'), /repeating itself/);
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the provider comes from --provider, then RADAR_PROVIDER, then defaults to Claude", () => {
  const fetch = ollama({}).fetch;
  assert.deepEqual(pick({}), ["claude", "claude-haiku-5-5"]);
  assert.deepEqual(pick({ RADAR_PROVIDER: "ollama" }), ["ollama", "qwen3:14b"]);
  assert.deepEqual(pick({ RADAR_PROVIDER: "ollama", RADAR_MODEL: "gemma3:12b" }), ["ollama", "gemma3:12b"]);
  assert.deepEqual(pick({ RADAR_PROVIDER: "claude" }, "Ollama"), ["ollama", "qwen3:14b"]);
  assert.throws(() => pick({ RADAR_PROVIDER: "gpt" }), /Unknown provider "gpt"/);

  function pick(env: Record<string, string>, override?: string) {
    const choice = chooseAssessor(testProfile(), { ANTHROPIC_API_KEY: "test", ...env }, fetch, override);
    return [choice.provider, choice.model];
  }
});
