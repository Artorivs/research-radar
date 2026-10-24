/**
 * The radar's vocabulary as types. GLOSSARY.md is the source of truth for what each term means;
 * this file only gives those terms a shape.
 */

export const KINDS = ["paper", "conference", "workshop", "seminar", "call", "course", "award", "job"] as const;
export type Kind = (typeof KINDS)[number];

export const EVENT_KINDS: readonly Kind[] = ["conference", "workshop", "seminar"];
export const isEvent = (kind: Kind): boolean => EVENT_KINDS.includes(kind);

export const LANGUAGES = ["en", "zh-Hans", "zh-Hant", "ja", "de", "other"] as const;
export type Language = (typeof LANGUAGES)[number];

export const ADJACENT = "Adjacent";

/** Status values allowed for each Kind. Dismissed is separate (see GLOSSARY.md). */
export const STATUSES: Record<Kind, readonly string[]> = {
  paper: ["saved", "read"],
  conference: ["saved", "submitted", "attending"],
  workshop: ["saved", "submitted", "attending"],
  seminar: ["saved", "submitted", "attending"],
  call: ["saved", "applied"],
  course: ["saved", "applied"],
  award: ["saved", "applied"],
  job: ["saved", "applied"],
};

export function isValidStatus(kind: Kind, status: string | null): boolean {
  return status === null || STATUSES[kind].includes(status);
}

export type DeadlineType = "submission" | "registration" | "other";

export interface Deadline {
  label: string;
  type: DeadlineType;
  /** ISO 8601 instant in UTC. */
  at: string;
  /** The deadline as the Source wrote it, e.g. "15 January 2027, 23:59 CET". */
  original: string;
}

export type LocationMode = "in_person" | "hybrid" | "online" | "unknown";

export interface Location {
  city: string | null;
  country: string | null;
  mode: LocationMode;
}

export interface Version {
  source: string;
  url: string;
  label: string;
  seenAt: string;
}

export type VoteValue = 1 | -1;

export interface Item {
  id: number;
  kind: Kind;
  /** Title in its original language and script. */
  title: string;
  /** Two-sentence summary in Oxford English. */
  summary: string;
  abstract: string;
  language: Language;
  topics: string[];
  score: number;
  url: string;
  doi: string | null;
  keynotes: string[];
  location: Location | null;
  /** Start and end of an Event, ISO dates. */
  startsOn: string | null;
  endsOn: string | null;
  seriesKey: string | null;
  callForEventId: number | null;
  deadlines: Deadline[];
  versions: Version[];
  status: string | null;
  dismissed: boolean;
  vote: VoteValue | null;
  /** Set when a later Version of a saved Paper appeared, e.g. "now published in ICLQ". */
  versionNote: string | null;
  firstSeenAt: string;
}

/**
 * Past: an Event that has taken place, or a non-Paper Item whose last Submission deadline has passed.
 * Derived from dates, never stored.
 */
export function isPast(item: Pick<Item, "kind" | "startsOn" | "endsOn" | "deadlines">, now: Date): boolean {
  if (item.kind === "paper") return false;
  if (isEvent(item.kind)) {
    const last = item.endsOn ?? item.startsOn;
    if (last) return endOfDayUtc(last) < now;
  }
  const submissions = item.deadlines.filter((d) => d.type === "submission");
  if (submissions.length === 0) return false;
  return submissions.every((d) => new Date(d.at) < now);
}

function endOfDayUtc(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T23:59:59Z`);
}

/** The next Submission deadline still ahead of `now`, if any. */
export function nextSubmissionDeadline(item: Pick<Item, "deadlines">, now: Date): Deadline | null {
  const ahead = item.deadlines
    .filter((d) => d.type === "submission" && new Date(d.at) >= now)
    .sort((a, b) => a.at.localeCompare(b.at));
  return ahead[0] ?? null;
}

/**
 * The Series an Event belongs to, as a key: its title with years, editions and ordinals removed,
 * so "ESIL 2027 Annual Conference" and "18th ESIL Annual Conference (2026)" share one key.
 */
export function seriesKeyFor(title: string): string {
  const key = title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(st|nd|rd|th)\b/g, " ")
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g, " ")
    .replace(/第[0-9一二三四五六七八九十百]+[届回]/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key;
}

/** A key for spotting the same Paper or Event arriving from different Sources. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}
