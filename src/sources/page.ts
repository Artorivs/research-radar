/**
 * Reads an ordinary web page: a conference's call-for-papers page, an institute's events page, a journal's
 * submissions page. These have no feed, so the page itself is the Entry, and it is read again whenever its
 * text changes. The Entry's id carries a digest of the text, so an unchanged page is never reassessed.
 */
import { createHash } from "node:crypto";
import type { SourcesConfig } from "../config.ts";
import { refuseBotCheck, stripHtml, type Entry, type Fetch } from "./entry.ts";

type Page = SourcesConfig["pages"][number];

/** Pages can be long; the essentials of a call are near the top, and this keeps one Entry a sensible size. */
const MAX_CHARS = 20_000;

export async function readPage(page: Page, fetch: Fetch, now: Date): Promise<Entry[]> {
  const res = await fetch(page.url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  if (!res.ok) throw new Error(`${page.name} returned ${res.status}`);
  const html = await res.text();
  refuseBotCheck(page.name, html);
  return [pageEntry(page, html, now)];
}

export function pageEntry(page: Page, html: string, now: Date): Entry {
  const main = stripHtml(dropNavigation(html)).slice(0, MAX_CHARS);
  return {
    source: page.id,
    // A page carries no publication date, so its text stands in for one: new text means a new Entry.
    entryId: `${page.url}#${createHash("sha256").update(main).digest("hex").slice(0, 16)}`,
    url: page.url,
    title: pageTitle(html) || page.name,
    text: main,
    kind: "page",
    // When the page last changed is unknown, so the Deadline year is reckoned from the day it was read.
    publishedAt: now.toISOString(),
    paper: null,
  };
}

/** Menus and footers repeat on every page of a site and would drown a short call in boilerplate. */
function dropNavigation(html: string): string {
  return html.replace(/<head\b[\s\S]*?<\/head>/gi, " ").replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
}

function pageTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  return stripHtml(heading ?? title ?? "").replace(/\s+/g, " ").trim();
}
