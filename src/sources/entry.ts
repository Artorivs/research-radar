/**
 * An Entry is one raw record read from a Source: a work from OpenAlex, a post from a blog feed.
 * One Entry can yield zero, one or several Items (an announcements post often lists several Calls).
 */
export interface Entry {
  /** Source id from config/sources.json, e.g. "openalex" or "ejiltalk". */
  source: string;
  /** Stable id within the Source, used to avoid reading the same Entry twice. */
  entryId: string;
  url: string;
  title: string;
  /** Body text: an abstract, or a post's content with markup stripped. */
  text: string;
  publishedAt: string | null;
  /** Set when the Source already knows the Entry is a Paper (e.g. OpenAlex). */
  paper: { doi: string | null; venue: string | null; versionLabel: string } | null;
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
