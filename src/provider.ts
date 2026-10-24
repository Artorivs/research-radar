/**
 * Picks the model that assesses Entries: Claude through the Anthropic API, or a local model through Ollama.
 * Chosen by RADAR_PROVIDER (claude | ollama) in .env or --provider on the command line.
 */
import { claudeAssessor, DEFAULT_MODEL, type Assessor } from "./assess.ts";
import type { Profile } from "./config.ts";
import { OLLAMA_DEFAULT_HOST, OLLAMA_DEFAULT_MODEL, ollamaAssessor } from "./ollama.ts";
import type { Fetch } from "./sources/entry.ts";

export const PROVIDERS = ["claude", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ProviderChoice {
  provider: Provider;
  model: string;
  assess: Assessor;
}

export function chooseAssessor(profile: Profile, env: Record<string, string | undefined>, fetch: Fetch, override?: string): ProviderChoice {
  const provider = (override ?? env.RADAR_PROVIDER ?? "claude").toLowerCase();
  if (provider === "ollama") {
    const model = env.RADAR_MODEL || OLLAMA_DEFAULT_MODEL;
    return { provider, model, assess: ollamaAssessor(profile, fetch, model, env.OLLAMA_HOST || OLLAMA_DEFAULT_HOST) };
  }
  if (provider === "claude") {
    const model = env.RADAR_MODEL || DEFAULT_MODEL;
    return { provider, model, assess: claudeAssessor(profile, undefined, model) };
  }
  throw new Error(`Unknown provider "${provider}"; use one of: ${PROVIDERS.join(", ")}`);
}
