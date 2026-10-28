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
  /** "page" for a whole web page rather than one post, which the prompt mentions so dates are read with care. */
  kind?: "page";
  /** Set when the Source already knows the Entry is a Paper (e.g. OpenAlex). */
  paper: { doi: string | null; venue: string | null; versionLabel: string } | null;
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** The named entities that turn up in announcements; anything rarer is left as written. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", times: "×", shy: "", zwj: "", zwnj: "",
};

/**
 * Some hosts (SiteGround, Cloudflare) answer a request they take for a bot with a captcha page instead of
 * the feed or page, often because the address it comes from belongs to a VPN or data centre.
 */
export function refuseBotCheck(name: string, body: string): void {
  if (/sgcaptcha|challenge-platform|cf-chl-|<title>Just a moment/i.test(body.slice(0, 5000))) {
    throw new Error(`${name} showed a bot check (captcha) instead of its content. This often clears by itself; if you use a VPN, try without it`);
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+\d*);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
