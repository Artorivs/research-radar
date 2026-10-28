/**
 * Asks a model what an Entry contains and how relevant it is to a Profile. The schema and prompts here are
 * shared by every provider; this file also holds the Claude provider (see ollama.ts for the local one).
 *
 * One call per Entry returns every Item in it (a Paper, a blog post or news report, or the Calls, Events,
 * Courses, Awards and Jobs a post announces), each with a Score on the written rubric, Topics, an Oxford English summary, and the
 * Deadlines, Location and keynote speakers the text gives.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Profile } from "./config.ts";
import { ADJACENT, KINDS, LANGUAGES } from "./domain.ts";
import type { Entry } from "./sources/entry.ts";
import type { CalibrationVote } from "./store.ts";

export const DEFAULT_MODEL = "claude-haiku-5-5";

export function assessmentSchema(profile: Profile) {
  const topicNames: [string, ...string[]] = [ADJACENT, ...profile.topics.map((t) => t.name)];
  return z.object({
    items: z.array(
      z.object({
        kind: z.enum(KINDS),
        title: z.string().describe("The Item's own title, in its original language and script"),
        summary: z.string().describe("Exactly two sentences in Oxford English"),
        description: z.string().describe("For non-Papers: the Item's own description, at most 150 words, in the original language"),
        language: z.enum(LANGUAGES).describe("Language of the title"),
        topics: z.array(z.enum(topicNames)),
        score: z.number().int().describe("Relevance from -10 to +10 on the rubric"),
        startsOn: z.string().nullable().describe("Event start date, YYYY-MM-DD"),
        endsOn: z.string().nullable().describe("Event end date, YYYY-MM-DD"),
        location: z
          .object({
            city: z.string().nullable(),
            country: z.string().nullable(),
            mode: z.enum(["in_person", "hybrid", "online", "unknown"]),
          })
          .nullable(),
        keynotes: z.array(z.string()).describe("Keynote speakers' names, if the text lists them"),
        deadlines: z.array(
          z.object({
            label: z.string().describe('e.g. "Abstract submission", "Registration"'),
            type: z.enum(["submission", "registration", "other"]),
            at: z.string().describe("The deadline as an ISO 8601 UTC instant, e.g. 2027-01-15T22:59:00Z"),
            original: z.string().describe("The deadline exactly as the text states it"),
          }),
        ),
        callForEvent: z
          .string()
          .nullable()
          .describe("For a Call aimed at an Event run by someone else: that Event's title"),
      }),
    ),
  });
}

export type Assessment = z.infer<ReturnType<typeof assessmentSchema>>;
export type AssessedItem = Assessment["items"][number];

/**
 * Thrown by an Assessor when no further Entry can succeed this run (no credit, a bad key, the local model
 * missing), so the run stops at once instead of failing every Entry the same way.
 */
export class StopRun extends Error {}

/** Turns one Entry into its Items. Swappable so tests and dry runs need no API key. */
export type Assessor = (entry: Entry, calibration: CalibrationVote[]) => Promise<AssessedItem[]>;

export function systemPrompt(profile: Profile): string {
  const topics = profile.topics.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const seeds = profile.seeds.length > 0 ? `\nWork the researcher values (seed papers):\n${profile.seeds.map((s) => `- ${s}`).join("\n")}\n` : "";
  return `You screen academic material for one researcher and decide what is worth their attention.

The researcher works in ${profile.field}. Their Topics:
${topics}
- ${ADJACENT}: use only when an Item scores +3 or higher but fits none of the Topics above.
${seeds}
## What counts as an Item

You receive one Entry: either a Paper record, a post from a blog, society or news feed, or a web page. Return every Item it contains, using these Kinds:
- paper: a single scholarly work from a Paper Entry. A Paper Entry yields exactly one paper Item. Never use paper for a post or a page.
- blog: a blog post that comments on or analyses law, a case, a treaty or events: commentary, case notes, symposium contributions, opinion pieces.
- news: a post that reports a development rather than offering an opportunity: a judgment handed down, a law passed, an appointment, a report, a new journal issue or book.
- call: ANY invitation to submit work: a call for papers, abstracts, panels or contributions to a conference, workshop, journal issue or edited volume, whoever issues it. If it is for an Event, put that Event's title in callForEvent and its dates and Location in startsOn, endsOn and location.
- conference: an Event with multiple panels, usually over several days, announced without an open call (e.g. registration or programme).
- workshop: a small, paper-based Event announced without an open call.
- seminar: an Event that is a single talk or session (including a lecture series session), online or in person. Never call it a webinar.
- course: structured teaching one enrols in, such as summer or winter schools, PhD courses and methods training.
- award: money or recognition applied for without an employment contract, such as grants, fellowships, prizes and scholarships.
- job: a post with an employment contract. If it is unclear whether a postdoctoral "fellowship" is salaried, treat it as a job.

Every call for papers is a call Item, never a conference or workshop Item; its abstract or paper deadline is a submission Deadline on the call.
A post that announces opportunities yields one Item for each and no blog or news Item. A post that only comments or reports yields exactly one blog or news Item.

## Deadlines

- type "submission" means sending work or an application: abstracts, full papers, panel proposals, applications, nominations. Registration and early-bird dates are "registration". Anything else is "other".
- Convert each deadline to a UTC instant in "at". AoE (Anywhere on Earth) is UTC-12. If no time is given, use 23:59 in the stated timezone; if no timezone is given either, use 23:59 UTC. If the year is missing, use the first occurrence after the Entry's publication date.
- Copy the deadline exactly as written into "original".

## Score: integer from -10 to +10

Use the whole range, and keep scores spread out: most material is not a close match.
- +9 to +10: squarely within a core Topic and plainly on this researcher's agenda; missing it would be a real loss.
- +6 to +8: clearly within a core Topic.
- +3 to +5: touches a Topic, or a broad call in the field that would welcome work on these Topics.
- +1 to +2: law-related but marginal to the Topics.
- 0: impossible to judge from the text.
- -1 to -5: legal scholarship outside these interests (e.g. tax, competition, IP doctrine).
- -6 to -10: not law, not academic (e.g. paid practitioner training or law firm marketing), or clearly irrelevant.
Judge relevance only. Location, travel and prestige never change the Score. Material in Chinese, Japanese or German is judged exactly as English material is.

## Writing

- summary: exactly two sentences in British English with Oxford spelling: -ize endings (organize, recognize) but -yse endings (analyse), and British spelling and vocabulary otherwise (programme, centre, labour, judgement). Say what the Item is and why it may matter to these Topics. Never translate the title; keep it in its original language and script.
- description: for non-Papers, the Item's own description from the text in its original language, trimmed to 150 words. For Papers, an empty string.
- language: zh-Hans for Simplified Chinese, zh-Hant for Traditional Chinese, ja, de, en, or other.`;
}

export function entryPrompt(entry: Entry, calibration: CalibrationVote[]): string {
  const votes =
    calibration.length > 0
      ? `Recent votes by the researcher, for calibration (👍 wants more like this, 👎 wants less):\n${calibration
          .map((v) => `${v.vote > 0 ? "👍" : "👎"} [${v.kind}] ${v.title}`)
          .join("\n")}\n\n`
      : "";
  const header = entry.paper
    ? `Paper Entry from ${entry.source}${entry.paper.venue ? `, venue: ${entry.paper.venue}` : ""}`
    : entry.kind === "page"
      ? `Web page from ${entry.source}, read today. It may describe one opportunity, several, or none; menus and
unrelated page furniture are not Items, and a date already past means the page is out of date, so return no Item for it`
      : `Feed Entry from ${entry.source}`;
  return `${votes}${header}
Published: ${entry.publishedAt ?? "unknown"}
URL: ${entry.url}
Title: ${entry.title}

${entry.text || "(no text)"}`;
}

export function claudeAssessor(profile: Profile, client = new Anthropic(), model = DEFAULT_MODEL): Assessor {
  const format = zodOutputFormat(assessmentSchema(profile));
  const system = systemPrompt(profile);
  return async (entry, calibration) => {
    let response;
    try {
      response = await client.messages.parse({
        model,
        max_tokens: 16000,
        output_config: { effort: "low", format },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: entryPrompt(entry, calibration) }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new StopRun(`The Anthropic API refused the key: ${error.message}`);
      }
      // An empty balance comes back as a plain 400 with no error type of its own.
      if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
        throw new StopRun("Your Anthropic credit balance is too low. Add credits, or switch to a local model (see README).");
      }
      throw error;
    }
    if (response.stop_reason === "refusal") {
      console.warn(`Skipped "${entry.title}": the model declined (${response.stop_details?.category ?? "no category"})`);
      return [];
    }
    if (response.stop_reason === "max_tokens") throw new Error(`Assessment of "${entry.title}" was cut off`);
    if (!response.parsed_output) throw new Error(`Assessment of "${entry.title}" did not match the schema`);
    return response.parsed_output.items;
  };
}
