/**
 * Reads posts from RSS 2.0 and Atom feeds (blogs, society news pages, journal tables of contents).
 */
import { XMLParser } from "fast-xml-parser";
import type { SourcesConfig } from "../config.ts";
import { refuseBotCheck, stripHtml, type Entry, type Fetch } from "./entry.ts";

type Feed = SourcesConfig["feeds"][number];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });

export async function readFeed(feed: Feed, fetch: Fetch): Promise<Entry[]> {
  const res = await fetch(feed.url, { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml" } });
  if (!res.ok) throw new Error(`${feed.name} returned ${res.status}`);
  const body = await res.text();
  refuseBotCheck(feed.name, body);
  return parseFeed(feed.id, body);
}

export function parseFeed(sourceId: string, xml: string): Entry[] {
  const doc = parser.parse(xml);
  const rssItems = asArray(doc?.rss?.channel?.item);
  if (rssItems.length > 0) {
    return rssItems.map((item) => ({
      source: sourceId,
      entryId: text(item.guid) || text(item.link),
      url: text(item.link),
      title: stripHtml(text(item.title)),
      text: stripHtml(text(item["content:encoded"]) || text(item.description)),
      publishedAt: toIso(text(item.pubDate)),
      paper: null,
    }));
  }
  return asArray(doc?.feed?.entry).map((entry) => {
    const links = asArray(entry.link);
    const alternate = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
    return {
      source: sourceId,
      entryId: text(entry.id) || (alternate?.["@href"] ?? ""),
      url: alternate?.["@href"] ?? "",
      title: stripHtml(text(entry.title)),
      text: stripHtml(text(entry.content) || text(entry.summary)),
      publishedAt: toIso(text(entry.published) || text(entry.updated)),
      paper: null,
    };
  });
}

// fast-xml-parser yields a string, a number, an object with "#text", or an array of those.
function text(node: any): string {
  if (node === undefined || node === null) return "";
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === "object") return text(node["#text"]);
  return String(node).trim();
}

function asArray(node: any): any[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

function toIso(date: string): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
