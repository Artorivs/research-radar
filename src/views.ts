/**
 * What a Profile sees: which Items clear its thresholds, and the calendar of their Submission deadlines.
 */
import type { Profile } from "./config.ts";
import { isPast, nextSubmissionDeadline, type Item } from "./domain.ts";

export interface ItemView extends Item {
  past: boolean;
  nextDeadline: string | null;
  meetsThreshold: boolean;
}

/** An Item with a Submission deadline still ahead uses the lower bar, since missing one costs more. */
export function meetsThreshold(item: Item, profile: Profile, now: Date): boolean {
  const bar = nextSubmissionDeadline(item, now) ? profile.thresholds.withOpenDeadline : profile.thresholds.general;
  return item.score >= bar;
}

export function viewOf(item: Item, profile: Profile, now: Date): ItemView {
  return {
    ...item,
    past: isPast(item, now),
    nextDeadline: nextSubmissionDeadline(item, now)?.at ?? null,
    meetsThreshold: meetsThreshold(item, profile, now),
  };
}

/**
 * An iCalendar feed of upcoming Submission deadlines for Items that are saved or clear the thresholds,
 * each with a reminder 14 days ahead to match the Alert.
 */
export function deadlinesCalendar(items: Item[], profile: Profile, now: Date): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//research-radar//deadlines//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:Research Radar (${profile.name})`];
  for (const item of items) {
    if (item.dismissed || !(item.status !== null || meetsThreshold(item, profile, now))) continue;
    for (const d of item.deadlines) {
      if (d.type !== "submission" || new Date(d.at) < now) continue;
      const stamp = icsTime(d.at);
      lines.push(
        "BEGIN:VEVENT",
        `UID:radar-${item.id}-${stamp}@research-radar`,
        `DTSTAMP:${icsTime(now.toISOString())}`,
        `DTSTART:${stamp}`,
        `DTEND:${stamp}`,
        `SUMMARY:${icsText(`${d.label}: ${item.title}`)}`,
        `DESCRIPTION:${icsText(`${item.summary}\n\nAs stated: ${d.original}\n${item.url}`)}`,
        `URL:${icsText(item.url)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsText(`${d.label} in 14 days: ${item.title}`)}`,
        "TRIGGER:-P14D",
        "END:VALARM",
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function icsTime(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 caps lines at 75 octets; longer ones continue on lines starting with a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const charSize = Buffer.byteLength(char, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (size + charSize > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += charSize;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
