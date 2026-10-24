/**
 * The local provider: assesses Entries with a model served by Ollama (https://ollama.com) on this machine,
 * so collection costs nothing. Same schema and prompts as the Claude provider.
 */
import { z } from "zod";
import { assessmentSchema, entryPrompt, systemPrompt, StopRun, type Assessor } from "./assess.ts";
import type { Profile } from "./config.ts";
import type { Fetch } from "./sources/entry.ts";

export const OLLAMA_DEFAULT_MODEL = "qwen3:14b";
export const OLLAMA_DEFAULT_HOST = "http://localhost:11434";

/** Room for the system prompt, a long post and the answer; Ollama's own default context is far smaller. */
const CONTEXT_TOKENS = 16_384;
/**
 * Long posts are cut to this many characters (about 3,000–4,000 tokens) to keep each Entry quick.
 * Announcements put the essentials first; long tails are almost always commentary, which yields no Items.
 */
const MAX_ENTRY_CHARS = 12_000;
/**
 * A cap on the answer's length. A real answer is a few hundred tokens per Item; without a cap, a model
 * that falls into repeating itself writes until the context is full, which can take a quarter of an hour.
 */
export const MAX_ANSWER_TOKENS = 4_096;
/** Errors that mean nothing is listening at the host, as opposed to one slow or failed request. */
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);

export function ollamaAssessor(profile: Profile, fetch: Fetch, model = OLLAMA_DEFAULT_MODEL, host = OLLAMA_DEFAULT_HOST): Assessor {
  const schema = assessmentSchema(profile);
  const format = jsonSchemaFor(schema);
  const system = systemPrompt(profile);
  return async (entry, calibration) => {
    const trimmed = entry.text.length > MAX_ENTRY_CHARS ? { ...entry, text: `${entry.text.slice(0, MAX_ENTRY_CHARS)}\n[…cut]` } : entry;
    let res: Awaited<ReturnType<Fetch>>;
    let body: string;
    try {
      // Streaming makes Ollama send headers with its first token, so a slow answer isn't cut off by
      // fetch's five-minute wait for response headers.
      res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          think: false,
          format,
          options: { temperature: 0, num_ctx: CONTEXT_TOKENS, num_predict: MAX_ANSWER_TOKENS },
          messages: [
            { role: "system", content: system },
            { role: "user", content: entryPrompt(trimmed, calibration) },
          ],
        }),
      });
      body = await res.text();
    } catch (error) {
      const code = causeCode(error);
      if (code && UNREACHABLE.has(code)) {
        throw new StopRun(`Ollama isn't answering at ${host}. Open the Ollama app (or run \`ollama serve\`) and try again.`);
      }
      throw new Error(`Ollama didn't finish this Entry (${code ?? (error as Error).message})`);
    }
    if (res.status === 404) throw new StopRun(`Ollama doesn't have the model "${model}". Run \`ollama pull ${model}\` first.`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
    const content = joinStream(body);
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error(`the model's answer wasn't valid JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`the model's answer didn't match the schema: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    return parsed.data.items;
  };
}

/** Ollama streams one JSON object per line; the answer is their `message.content` pieces in order. */
export function joinStream(ndjson: string): string {
  let content = "";
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string; done_reason?: string };
    if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
    if (chunk.done_reason === "length") throw new Error(`the model's answer ran past ${MAX_ANSWER_TOKENS} tokens (it was probably repeating itself)`);
    content += chunk.message?.content ?? "";
  }
  return content;
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code ?? (error as { code?: string }).code;
}

/**
 * The JSON Schema Ollama constrains its output with. Integer bounds are narrowed to the Score's −10…+10
 * (the only integer), since the grammar would otherwise have to spell out every safe integer.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "integer") {
      record.minimum = -10;
      record.maximum = 10;
    }
    Object.values(record).forEach(walk);
  };
  walk(json);
  return json;
}
