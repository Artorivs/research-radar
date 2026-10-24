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
/** Long posts are cut to this many characters so the prompt fits the context. */
const MAX_ENTRY_CHARS = 24_000;

export function ollamaAssessor(profile: Profile, fetch: Fetch, model = OLLAMA_DEFAULT_MODEL, host = OLLAMA_DEFAULT_HOST): Assessor {
  const schema = assessmentSchema(profile);
  const format = jsonSchemaFor(schema);
  const system = systemPrompt(profile);
  return async (entry, calibration) => {
    const trimmed = entry.text.length > MAX_ENTRY_CHARS ? { ...entry, text: `${entry.text.slice(0, MAX_ENTRY_CHARS)}\n[…cut]` } : entry;
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format,
          options: { temperature: 0, num_ctx: CONTEXT_TOKENS },
          messages: [
            { role: "system", content: system },
            { role: "user", content: entryPrompt(trimmed, calibration) },
          ],
        }),
      });
    } catch {
      throw new StopRun(`Ollama isn't answering at ${host}. Open the Ollama app (or run \`ollama serve\`) and try again.`);
    }
    const body = await res.text();
    if (res.status === 404) throw new StopRun(`Ollama doesn't have the model "${model}". Run \`ollama pull ${model}\` first.`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
    const content = (JSON.parse(body) as { message?: { content?: string } }).message?.content ?? "";
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
