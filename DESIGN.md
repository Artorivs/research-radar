# Research Radar — design (agreed in grilling session, 24 Oct 2026)

A personal tracker that collects conferences, CFPs, papers and other academic
opportunities worldwide, scores them against a researcher's interests, and
delivers them by weekly email and a local dashboard.

## 1. Users and profiles
- v1 has one user (Arthur). Colleagues may be added later if it works well.
- Interests live in a **profile** record (topics, seed papers, timezone,
  thresholds). A colleague later = a second profile. No accounts or login in v1.
- Seed papers are optional; v1 starts from topics alone and tunes via 👍/👎.

## 2. Topics (field: law)
1. International law
2. Socio-legal studies / sociology of law
3. Computational legal studies / computational law
4. Public inquiry
5. Law and politics
6. Constitutional law
7. Human rights
8. Administrative law
9. Adjacent / other — high-scoring items outside 1–8, so new interests can surface

## 3. Item model
Every item carries two independent axes plus metadata:
- **Kind** (fixed): Paper, Conference, Workshop, Seminar, Call, Course,
  Award, Job — see GLOSSARY.md. A conference's call for papers is a
  Submission deadline on the Event, not a separate Item.
- **Topics** (one or more, from §2, assigned by the model)
- **Abstract / description** (paper abstract or CFP/event text)
- **Keynote speakers** (conferences, when published)
- **Deadline** — stored in UTC, original timezone kept
- **Location** — place, plus in-person / hybrid / online
- Original title (any language) + **two-sentence English summary in
  British/Oxford English** (-ize, British vocabulary)
- Relevance score, user status (⭐ saved, submitted, attending), 👍/👎 vote

Duplicates (same event from several sources) merge into one item. Everything
is archived.

Behaviour rules (from the vocabulary session):
- A Call may link to an Event (e.g. a working group's panel call at LSA).
- Each lecture-series session is its own Seminar in a Series; the Digest
  groups them under the Series heading.
- Votes on one Event in a Series carry to later Events in it (net 👍 adds 2 to the
  Score, net 👎 subtracts 2); Dismissed does not.
- A later Version of a Paper stays out of the Digest unless the Paper was
  saved, in which case the Digest notes "now published in …".
- Past is derived from dates: Past Items leave the default dashboard but stay
  searchable, and their Status is kept.

## 4. Languages
English, Chinese (Simplified and Traditional), Japanese, German.

## 5. Sources (thin layer over existing feeds; configurable list)
- **Papers:** OpenAlex; SSRN eJournals (international, constitutional,
  administrative, human rights law; law & society; legal informatics);
  arXiv cs.CY; J-STAGE; journal RSS (AJIL, EJIL, ICLQ, I·CON, Public Law,
  HRLR, Law & Society Review, JLS, AI & Law).
- **CFPs / events:** EJIL:Talk!, Opinio Juris announcements, Verfassungsblog,
  Völkerrechtsblog, IACL-AIDC Blog, Strasbourg Observers, The Regulatory
  Review, ASIL, ESIL, ICON-S, LSA, SLSA, RCSL, ICAIL, JURIX, ACM CS&Law,
  WikiCFP (law), H-Net.
- **Mailing lists:** a Gmail label (e.g. `Radar`) that list mail is filtered into.
- **Jobs / grants:** jobs.ac.uk, EURAXESS, H-Net jobs, AcademicPositions.
- **Out of v1:** CNKI and Airiti (no usable API). Chinese coverage via OpenAlex
  plus named journal/society sites.

## 6. Relevance scoring
- Claude API (default `claude-haiku-5-5`, configurable via `RADAR_MODEL`) scores each item **−10 to +10** against the
  profile, using a written rubric per band, and writes the summary and topics.
- 👍/👎 feedback on the dashboard tunes future scoring: the 30 most recent Votes
  are sent with each assessment as calibration.
- Digest thresholds (adjustable): papers/events **≥ +4**; CFPs, grants, jobs **≥ +2**.
- Location is a filter only; it never affects the score.

## 7. Delivery
- **Weekly email** on Monday morning, in the profile's timezone (default UTC),
  sent via Gmail + app password to the user.
- **Deadline alert** email when a relevant, non-dismissed CFP is 14 days out.
- **Local dashboard** at `localhost`: filter by type, topic, language, deadline,
  location; hides scores < 0 by default (toggle to show all); ⭐ save;
  submitted/attending status; `.ics` export of deadlines. Email links open the
  item on the dashboard (works on the Mac only while local).

## 8. Runtime and stack
- Runs locally on the user's Mac: TypeScript + SQLite; daily fetch via launchd,
  catching up after sleep.
- Times stored in UTC; displayed in each profile's timezone.
- Budget ≤ $10/month (mainly Claude API, est. $2–5), near-zero upkeep.
- Later option: move to Cloudflare (Workers + D1 + Pages + Access).
- Code lives in a new private GitHub repo created by the user (e.g. `research-radar`).

## 9. Build order
1. OpenAlex + ~5 RSS feeds → scoring → dashboard
2. Weekly email + deadline alerts + Gmail label ingestion
3. Remaining sources, jobs and grants

First run loads currently open CFPs plus the last 30 days of papers.
