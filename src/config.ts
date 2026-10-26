/**
 * Loads the Profile and the Source list from config/. Both are plain JSON so they can be edited by hand.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const TopicSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** Search phrases for Sources that take a query (OpenAlex), in any of the radar's languages. */
  queries: z.array(z.string()).default([]),
});

const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().default(""),
  /** IANA timezone used to display times; everything is stored in UTC. */
  timezone: z.string().default("UTC"),
  field: z.string(),
  thresholds: z.object({
    /** Minimum Score for an Item to reach the Digest. */
    general: z.number().int(),
    /** Lower bar for Items with a Submission deadline still ahead, since missing one costs more. */
    withOpenDeadline: z.number().int(),
  }),
  topics: z.array(TopicSchema).min(1),
  /** Optional seed papers (titles or DOIs) that show the kind of work the researcher values. */
  seeds: z.array(z.string()).default([]),
});

const SourcesSchema = z.object({
  openalex: z.object({
    enabled: z.boolean(),
    /** Your email, sent to OpenAlex to join its faster "polite pool". Optional. */
    mailto: z.string().default(""),
    /** A free OpenAlex API key, which raises the daily allowance tenfold. Set OPENALEX_API_KEY in .env, not here. */
    apiKey: z.string().optional(),
    lookbackDays: z.number().int().positive(),
    /**
     * Papers whose venue name contains any of these (ignoring case) are skipped: open-upload sites with no
     * editorial or peer review, such as Zenodo.
     */
    /**
     * OpenAlex subfield ids (Scopus ASJC codes, e.g. 3308 Law) a Paper must be classed under, in any of its
     * topics. Its keyword search alone matches words loosely, Chinese and Japanese especially. Empty: no limit.
     */
    subfields: z.array(z.number().int().positive()).default([]),
    /** Journals whose every new article is read, found by ISSN. `npm run radar -- sources` checks each one. */
    journals: z.array(z.object({ name: z.string(), issn: z.string().regex(/^\d{4}-\d{3}[\dX]$/) })).default([]),
    excludeVenues: z.array(z.string().min(1)).default([]),
    /** Skips fully open-access journals that neither the DOAJ nor the CWTS core list vouches for: the usual mark of a predatory journal. */
    skipUnvettedOpenAccessJournals: z.boolean().default(true),
    perQuery: z.number().int().positive().max(200),
  }),
  feeds: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      url: z.string().url(),
      /** false keeps a feed listed but unread, e.g. one that needs a local service running first. */
      enabled: z.boolean().optional(),
    }),
  ),
  /** Ordinary web pages with no feed, such as a conference's call-for-papers page. Read again when the text changes. */
  pages: z
    .array(z.object({ id: z.string().min(1), name: z.string(), url: z.string().url(), enabled: z.boolean().optional() }))
    .default([]),
});

export type Topic = z.infer<typeof TopicSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type SourcesConfig = z.infer<typeof SourcesSchema>;

export function loadProfile(path: string): Profile {
  return ProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadSources(path: string): SourcesConfig {
  return SourcesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function withOpenAlexKey(sources: SourcesConfig, key: string | undefined): SourcesConfig {
  return key ? { ...sources, openalex: { ...sources.openalex, apiKey: key } } : sources;
}
