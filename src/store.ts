/**
 * The radar's archive: one SQLite file holding every Item, its Deadlines and Versions, and each
 * Profile's judgement of it (Score, Topics, Status, Dismissed, Vote).
 *
 * Facts about an Item are shared; judgements belong to a Profile, so a colleague is just another Profile.
 */
import { DatabaseSync } from "node:sqlite";
import {
  KINDS,
  isValidStatus,
  titleKey,
  type Deadline,
  type Item,
  type Kind,
  type Language,
  type Location,
  type Version,
  type VoteValue,
} from "./domain.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  abstract TEXT NOT NULL,
  language TEXT NOT NULL,
  url TEXT NOT NULL,
  doi TEXT,
  keynotes TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  starts_on TEXT,
  ends_on TEXT,
  series_key TEXT,
  call_for_event_id INTEGER REFERENCES items(id),
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_doi ON items(doi);
CREATE INDEX IF NOT EXISTS items_title_key ON items(kind, title_key);
CREATE INDEX IF NOT EXISTS items_series ON items(series_key);

CREATE TABLE IF NOT EXISTS deadlines (
  item_id INTEGER NOT NULL REFERENCES items(id),
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  original TEXT NOT NULL,
  UNIQUE (item_id, type, at)
);

CREATE TABLE IF NOT EXISTS versions (
  item_id INTEGER NOT NULL REFERENCES items(id),
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  UNIQUE (item_id, url)
);

CREATE TABLE IF NOT EXISTS judgements (
  item_id INTEGER NOT NULL REFERENCES items(id),
  profile_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  topics TEXT NOT NULL,
  status TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,
  vote INTEGER,
  voted_at TEXT,
  version_note TEXT,
  PRIMARY KEY (item_id, profile_id)
);

CREATE TABLE IF NOT EXISTS seen_entries (
  source TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (source, entry_id)
);
`;

/** The facts about a newly found Item, before it has an id. */
export interface NewItem {
  kind: Kind;
  title: string;
  summary: string;
  abstract: string;
  language: Language;
  url: string;
  doi: string | null;
  keynotes: string[];
  location: Location | null;
  startsOn: string | null;
  endsOn: string | null;
  seriesKey: string | null;
  callForEventId: number | null;
}

export interface CalibrationVote {
  kind: Kind;
  title: string;
  vote: VoteValue;
}

type Row = Record<string, unknown>;

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  hasSeen(source: string, entryId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM seen_entries WHERE source = ? AND entry_id = ?").get(source, entryId) !== undefined;
  }

  markSeen(source: string, entryId: string, now: Date): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO seen_entries (source, entry_id, seen_at) VALUES (?, ?, ?)")
      .run(source, entryId, now.toISOString());
  }

  /**
   * Removes Papers known only from excluded venues, along with their Deadlines, Versions and judgements.
   * Papers anyone has saved, or that also have a Version elsewhere, stay. Returns how many were removed.
   */
  removePapersOnlyFrom(isExcluded: (versionLabel: string) => boolean): number {
    const papers = this.#db
      .prepare(
        `SELECT i.id, json_group_array(v.label) AS labels FROM items i JOIN versions v ON v.item_id = i.id
         WHERE i.kind = 'paper' AND NOT EXISTS (SELECT 1 FROM judgements j WHERE j.item_id = i.id AND j.status IS NOT NULL)
         GROUP BY i.id`,
      )
      .all() as Row[];
    const doomed = papers.filter((p) => (JSON.parse(String(p.labels)) as string[]).every(isExcluded)).map((p) => Number(p.id));
    this.#remove(doomed);
    return doomed.length;
  }

  /**
   * Removes every Paper nobody has saved, voted on or dismissed, and forgets which OpenAlex records were
   * read, so the next run reads them again through the current filters. Returns how many were removed.
   */
  forgetPapers(): number {
    const ids = (
      this.#db
        .prepare(
          `SELECT i.id FROM items i WHERE i.kind = 'paper' AND NOT EXISTS (
             SELECT 1 FROM judgements j WHERE j.item_id = i.id AND (j.status IS NOT NULL OR j.vote IS NOT NULL OR j.dismissed = 1))`,
        )
        .all() as Row[]
    ).map((r) => Number(r.id));
    this.#remove(ids);
    this.#db.prepare("DELETE FROM seen_entries WHERE source = 'openalex'").run();
    return ids.length;
  }

  #remove(ids: number[]): void {
    for (const id of ids) {
      for (const table of ["deadlines", "versions", "judgements"]) this.#db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(id);
      this.#db.prepare("DELETE FROM items WHERE id = ?").run(id);
    }
  }

  /** The existing Paper with this DOI or title, if any. */
  findPaper(doi: string | null, title: string): number | null {
    if (doi) {
      const byDoi = this.#db.prepare("SELECT id FROM items WHERE kind = 'paper' AND doi = ?").get(doi) as Row | undefined;
      if (byDoi) return Number(byDoi.id);
    }
    const byTitle = this.#db
      .prepare("SELECT id FROM items WHERE kind = 'paper' AND title_key = ?")
      .get(titleKey(title)) as Row | undefined;
    return byTitle ? Number(byTitle.id) : null;
  }

  /** The existing non-Paper Item with this Kind and title, if any. Same-titled Events must also share a start date. */
  findOpportunity(kind: Kind, title: string, startsOn: string | null): number | null {
    const row = this.#db
      .prepare("SELECT id FROM items WHERE kind = ? AND title_key = ? AND (starts_on IS ? OR starts_on IS NULL OR ? IS NULL)")
      .get(kind, titleKey(title), startsOn, startsOn) as Row | undefined;
    return row ? Number(row.id) : null;
  }

  /** The Event a Call is for, matched loosely by title. */
  findEventByTitle(title: string): number | null {
    const row = this.#db
      .prepare("SELECT id FROM items WHERE kind IN ('conference','workshop','seminar') AND title_key = ? ORDER BY id DESC")
      .get(titleKey(title)) as Row | undefined;
    return row ? Number(row.id) : null;
  }

  insertItem(item: NewItem, now: Date): number {
    const result = this.#db
      .prepare(
        `INSERT INTO items (kind, title, title_key, summary, abstract, language, url, doi, keynotes, location,
           starts_on, ends_on, series_key, call_for_event_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.kind,
        item.title,
        titleKey(item.title),
        item.summary,
        item.abstract,
        item.language,
        item.url,
        item.doi,
        JSON.stringify(item.keynotes),
        item.location ? JSON.stringify(item.location) : null,
        item.startsOn,
        item.endsOn,
        item.seriesKey,
        item.callForEventId,
        now.toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Fills facts the existing Item lacks (location, dates, keynotes) from a later sighting. */
  fillGaps(id: number, item: NewItem): void {
    this.#db
      .prepare(
        `UPDATE items SET
           location = COALESCE(location, ?),
           starts_on = COALESCE(starts_on, ?),
           ends_on = COALESCE(ends_on, ?),
           keynotes = CASE WHEN keynotes = '[]' THEN ? ELSE keynotes END,
           abstract = CASE WHEN abstract = '' THEN ? ELSE abstract END
         WHERE id = ?`,
      )
      .run(
        item.location ? JSON.stringify(item.location) : null,
        item.startsOn,
        item.endsOn,
        JSON.stringify(item.keynotes),
        item.abstract,
        id,
      );
  }

  addDeadlines(itemId: number, deadlines: Deadline[]): void {
    const insert = this.#db.prepare(
      "INSERT OR IGNORE INTO deadlines (item_id, label, type, at, original) VALUES (?, ?, ?, ?, ?)",
    );
    for (const d of deadlines) insert.run(itemId, d.label, d.type, d.at, d.original);
  }

  /** Records a Version; returns false if this URL was already known for the Item. */
  addVersion(itemId: number, version: Version): boolean {
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO versions (item_id, source, url, label, seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, version.source, version.url, version.label, version.seenAt);
    return Number(result.changes) > 0;
  }

  hasJudgement(itemId: number, profileId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM judgements WHERE item_id = ? AND profile_id = ?").get(itemId, profileId) !== undefined;
  }

  saveJudgement(itemId: number, profileId: string, score: number, topics: string[]): void {
    this.#db
      .prepare(
        `INSERT INTO judgements (item_id, profile_id, score, topics) VALUES (?, ?, ?, ?)
         ON CONFLICT (item_id, profile_id) DO UPDATE SET score = excluded.score, topics = excluded.topics`,
      )
      .run(itemId, profileId, score, JSON.stringify(topics));
  }

  /** Notes a new Version on a Paper the Profile has saved, so the Digest can say "now published in …". */
  noteNewVersion(itemId: number, profileId: string, note: string): void {
    this.#db
      .prepare("UPDATE judgements SET version_note = ? WHERE item_id = ? AND profile_id = ? AND status = 'saved'")
      .run(note, itemId, profileId);
  }

  setStatus(itemId: number, profileId: string, status: string | null): void {
    const row = this.#db.prepare("SELECT kind FROM items WHERE id = ?").get(itemId) as Row | undefined;
    if (!row) throw new Error(`No Item ${itemId}`);
    const kind = row.kind as Kind;
    if (!isValidStatus(kind, status)) throw new Error(`"${status}" is not a Status for a ${kind}`);
    this.#judgementRow(itemId, profileId);
    this.#db.prepare("UPDATE judgements SET status = ? WHERE item_id = ? AND profile_id = ?").run(status, itemId, profileId);
  }

  setDismissed(itemId: number, profileId: string, dismissed: boolean): void {
    this.#judgementRow(itemId, profileId);
    this.#db
      .prepare("UPDATE judgements SET dismissed = ? WHERE item_id = ? AND profile_id = ?")
      .run(dismissed ? 1 : 0, itemId, profileId);
  }

  setVote(itemId: number, profileId: string, vote: VoteValue | null, now: Date): void {
    this.#judgementRow(itemId, profileId);
    this.#db
      .prepare("UPDATE judgements SET vote = ?, voted_at = ? WHERE item_id = ? AND profile_id = ?")
      .run(vote, vote === null ? null : now.toISOString(), itemId, profileId);
  }

  /** The Profile's most recent Votes, shown to the model as calibration. */
  recentVotes(profileId: string, limit: number): CalibrationVote[] {
    const rows = this.#db
      .prepare(
        `SELECT i.kind, i.title, j.vote FROM judgements j JOIN items i ON i.id = j.item_id
         WHERE j.profile_id = ? AND j.vote IS NOT NULL ORDER BY j.voted_at DESC LIMIT ?`,
      )
      .all(profileId, limit) as Row[];
    return rows.map((r) => ({ kind: r.kind as Kind, title: String(r.title), vote: Number(r.vote) as VoteValue }));
  }

  /** The net Vote (+n / −n) the Profile has given earlier Events in a Series. */
  seriesVote(profileId: string, seriesKey: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(j.vote), 0) AS net FROM judgements j JOIN items i ON i.id = j.item_id
         WHERE j.profile_id = ? AND i.series_key = ? AND j.vote IS NOT NULL`,
      )
      .get(profileId, seriesKey) as Row;
    return Number(row.net);
  }

  /** Every Item the Profile has a judgement on, newest first. Filtering for display happens in the caller. */
  items(profileId: string): Item[] {
    const rows = this.#db
      .prepare(
        `SELECT i.*, j.score, j.topics, j.status, j.dismissed, j.vote, j.version_note
         FROM items i JOIN judgements j ON j.item_id = i.id AND j.profile_id = ?
         ORDER BY i.first_seen_at DESC, i.id DESC`,
      )
      .all(profileId) as Row[];
    const deadlines = this.#db.prepare("SELECT * FROM deadlines WHERE item_id = ? ORDER BY at");
    const versions = this.#db.prepare("SELECT * FROM versions WHERE item_id = ? ORDER BY seen_at");
    return rows.map((r) => ({
      id: Number(r.id),
      kind: KINDS.includes(r.kind as Kind) ? (r.kind as Kind) : "paper",
      title: String(r.title),
      summary: String(r.summary),
      abstract: String(r.abstract),
      language: r.language as Language,
      topics: JSON.parse(String(r.topics)) as string[],
      score: Number(r.score),
      url: String(r.url),
      doi: (r.doi as string | null) ?? null,
      keynotes: JSON.parse(String(r.keynotes)) as string[],
      location: r.location ? (JSON.parse(String(r.location)) as Location) : null,
      startsOn: (r.starts_on as string | null) ?? null,
      endsOn: (r.ends_on as string | null) ?? null,
      seriesKey: (r.series_key as string | null) ?? null,
      callForEventId: r.call_for_event_id === null ? null : Number(r.call_for_event_id),
      deadlines: (deadlines.all(r.id as number) as Row[]).map((d) => ({
        label: String(d.label),
        type: d.type as Deadline["type"],
        at: String(d.at),
        original: String(d.original),
      })),
      versions: (versions.all(r.id as number) as Row[]).map((v) => ({
        source: String(v.source),
        url: String(v.url),
        label: String(v.label),
        seenAt: String(v.seen_at),
      })),
      status: (r.status as string | null) ?? null,
      dismissed: Number(r.dismissed) === 1,
      vote: r.vote === null ? null : (Number(r.vote) as VoteValue),
      versionNote: (r.version_note as string | null) ?? null,
      firstSeenAt: String(r.first_seen_at),
    }));
  }

  #judgementRow(itemId: number, profileId: string): void {
    if (!this.hasJudgement(itemId, profileId)) throw new Error(`Item ${itemId} has not been scored for ${profileId}`);
  }
}
