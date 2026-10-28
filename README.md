# Research Radar

A personal radar for academic work. It reads papers, conferences, calls, courses, awards and jobs from
existing Sources, asks Claude how relevant each one is to your interests, and shows the results on a
dashboard on your Mac.

- **What it means by Item, Kind, Call, Series, Score and so on:** [GLOSSARY.md](GLOSSARY.md)
- **What was decided and why:** [DESIGN.md](DESIGN.md) and [docs/adr/](docs/adr/)

This is **build stage 1**: OpenAlex, forty-five watched journals, and blog, society and conference feeds and pages, scoring, and the dashboard. The weekly Digest,
deadline Alerts and the Gmail label come in stage 2.

## Set up on your Mac

1. Install Node.js 22.13 or newer (`node --version` shows yours; `brew install node` if needed).
2. Clone this repository and install it:
   ```sh
   git clone https://github.com/Artorivs/research-radar.git ~/research-radar
   cd ~/research-radar
   npm install
   ```
3. Choose the model that reads and scores Entries, and set it in `.env`:
   ```sh
   cp .env.example .env
   open -e .env
   ```
   - **Claude** (the default): paste your key after `ANTHROPIC_API_KEY=`.
   - **A free local model**: set `RADAR_PROVIDER=ollama` and follow [Local model](#local-model) below.
4. Check [config/profile.json](config/profile.json). It holds your Topics, the search phrases used for
   OpenAlex (in English, Chinese, Japanese and German), your timezone and the thresholds. Set `timezone`
   to yours, e.g. `"Europe/London"` or `"Asia/Hong_Kong"`. You can add seed papers under `"seeds"`.
5. Try a small first run. `--limit 3` sends only three new Entries per Source to the model; the rest wait
   for the next run.
   ```sh
   npm run radar -- collect --limit 3
   npm run radar -- serve
   ```
   Then open <http://localhost:4747>.
6. When the results look sensible, run `npm run radar -- collect` without a limit. The first full run
   reads the last 30 days of papers, so it takes a while and costs the most.

## Run it automatically

Two launchd jobs are in [launchd/](launchd/): one collects every morning at 07:00 (and catches up when
the Mac wakes if it was asleep), and one keeps the dashboard running.

```sh
cd ~/research-radar
for job in collect dashboard; do
  sed "s|RADAR_DIR|$PWD|" launchd/com.research-radar.$job.plist > ~/Library/LaunchAgents/com.research-radar.$job.plist
  launchctl load ~/Library/LaunchAgents/com.research-radar.$job.plist
done
```

Logs go to `data/collect.log` and `data/dashboard.log`. To stop a job, run
`launchctl unload ~/Library/LaunchAgents/com.research-radar.<job>.plist`.

## Using the dashboard

- Beside the Kind, each card names where the Item was found: a Paper's journal or repository, or the
  blog, society or page that announced anything else. To stop seeing a journal or site, add it to
  `excludeVenues` (see [Paper quality filters](#paper-quality-filters)).
- **Score** runs from −10 to +10. Items below 0, Past Items and Dismissed Items are hidden until you tick
  the boxes to show them.
- **⭐ Save** sets the Status to "saved". The Status menu offers the values that fit the Kind: read for
  Papers, blog posts and News; submitted and applied for Calls; submitted and attending for Events;
  applied for Courses, Awards and Jobs.
- **👍 / 👎** are Votes. The 30 most recent are shown to Claude with every new Entry, so scoring drifts
  towards your taste. A Vote on one edition of a recurring Event moves the next edition's Score by 2.
- **Dismiss** means "not for me now". It hides the Item but doesn't change future Scores.
- **Export deadlines (.ics)** downloads the Submission deadlines of Items you saved or that clear your
  thresholds, each with a reminder 14 days ahead. Times are stored in UTC and shown in your timezone.

## Sources

Edit [config/sources.json](config/sources.json) to add or remove Sources. Any RSS or Atom feed works,
including a blog's category feed (e.g. only its calls for papers), which saves the model reading
commentary. Pages without a feed go under `"pages"` (see below). To switch any Source off without
deleting it, add `"enabled": false`.

After changing the list, check that every address can be read before a long run:

```sh
npm run radar -- sources
```

It prints ✓ with the number of posts (or, for a page, its length and title), ? when a feed address is
really a web page or a page holds almost no text, and ✗ with the error. Nothing is assessed or saved.

### Pages without a feed

Many journals and institutes announce calls on a plain web page, such as a conference's call-for-papers
page. Those go under `"pages"` in [config/sources.json](config/sources.json):

```json
"pages": [
  { "id": "asli-conf", "name": "ASLI Annual Conference", "url": "https://law1a.nus.edu.sg/asli/24th_asli_conf/call_for_papers.html" }
]
```

The whole page is one Entry: menus, headers and footers are dropped, and the rest is read as a single
announcement, which may yield several Items or none. A page is read again only when its text changes, so
an unchanged page costs nothing on later runs. `"enabled": false` works here too.

Three things to know:

- A page that shows anything which changes by itself, such as today's date or a visitor count, is read
  again on every run. If a page keeps being reassessed, take it out.
- A page built by JavaScript gives almost no text. `npm run radar -- sources` reports that as ?, and there
  is nothing to be done but find another address.
- An address tied to one year, like `24th_asli_conf`, stops working when the next conference is announced.
  Prefer the society's standing calls page where there is one, and expect to update these now and then.

### WeChat Public Accounts (公众号)

WeChat offers no feeds, but [WeWe RSS](https://github.com/cooderl/wewe-rss), a free tool you run on your
Mac, turns the Public Accounts you choose into one feed via your WeChat Reading (微信读书) account.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. Start WeWe RSS, choosing your own password after `AUTH_CODE=`:
   ```sh
   docker run -d --name wewe-rss --restart unless-stopped -p 4000:4000 \
     -e DATABASE_TYPE=sqlite -e AUTH_CODE=choose-a-password -e FEED_MODE=fulltext \
     -v ~/wewe-rss:/app/data cooderl/wewe-rss-sqlite:latest
   ```
3. Open <http://localhost:4000> and enter that password. Under 账号管理 (accounts), add your WeChat
   Reading account by scanning the QR code with WeChat.
4. Under 公众号源 (Public Accounts), add each account by pasting the share link of any one of its
   articles. Add a few at a time: adding many quickly gets you paused for 24 hours.
5. In [config/sources.json](config/sources.json), change `"enabled": false` to `true` on
   "WeChat Public Accounts", then run `npm run radar -- sources` to check it.

WeWe RSS is an unofficial tool kept up by one person. The WeChat Reading login lapses now and then; when
the check shows ✗ or the feed stops updating, scan the QR code again. Docker must be running at collect
time (07:00 if you use the launchd job).

### Watched journals

Besides searching by Topic, the radar reads **every** new article in the journals listed under
`openalex.journals` in [config/sources.json](config/sources.json), found by ISSN, whatever its wording.
The list starts with forty-five leading journals across your Topics: international law, human rights,
constitutional and administrative law, socio-legal studies, law and politics, and computational and
empirical legal studies, in English, Chinese, Japanese and German. Add or remove any:

```json
{ "name": "Modern Law Review", "issn": "0026-7961" }
```

`npm run radar -- sources` looks each ISSN up in OpenAlex. It flags with ✗ an ISSN OpenAlex doesn't know
(some Chinese and Japanese journals aren't indexed there) and with ? one whose OpenAlex name differs from
yours, which usually means a wrong ISSN. These lookups are free.

OpenAlex doesn't index 中国法学, 法学研究, 中外法学, 环球法律评论 or 国際法外交雑誌, so they aren't on the list.
Where a journal runs a WeChat Public Account, follow it through [WeWe RSS](#wechat-public-accounts-公众号)
instead.

The first run after adding journals reads a month of their articles, a few hundred, which takes some hours
with a local model. After that it is a handful a day.

### Paper quality filters

OpenAlex indexes almost everything, including uploads nobody has reviewed. Before the model sees a Paper,
these filters in [config/sources.json](config/sources.json) drop the worst of it:

- **`subfields`:** one of these subfields must be the record's main topic in OpenAlex. Its keyword search
  matches words loosely, Chinese and Japanese above all, and a paper on theatre or medicine often carries a
  minor topic in political science, so only the main topic counts. The ids are Scopus subject codes:
  3308 Law, 3312 Sociology and Political Science, 3320 Political Science and International Relations,
  3321 Public Administration. `npm run radar -- sources` prints the names OpenAlex gives them, to confirm.
- **`onlyVettedVenues`:** a searched record is kept only if its journal is on the CWTS core list (the
  established journals behind the Leiden Ranking) or in the Directory of Open Access Journals, or its venue
  is named in **`trustedVenues`** (SSRN to start with). This drops predatory journals, open-upload sites and
  obscure venues. It also drops some sound journals, especially Chinese ones; add any you trust to
  `trustedVenues`, or to the watched journals.
- **Open-upload sites:** a record from Zenodo, Figshare, OSF, ResearchGate, Academia.edu, Preprints.org,
  Research Square, Qeios, Authorea or the Internet Archive is skipped, recognised by its DOI or address even
  when OpenAlex files it under another venue's name.
- **No venue:** a record with no known journal or repository is skipped.
- **`excludeVenues`:** a record whose venue name contains any of these words is skipped. Add any journal
  you never want to see.

Papers from the watched journals pass the vetting check, since you chose those journals yourself. The other
filters still apply.

### OpenAlex key

OpenAlex bills each search against a small free daily allowance. A collect run makes one search per
query in your profile (42 at present), so without a key the allowance runs out after a run or two a day,
and OpenAlex answers "429". A free key raises the allowance tenfold, which is ample for a daily run:

1. Create a free account at [openalex.org](https://openalex.org) and copy the API key from your account
   settings.
2. Add it to `.env`: `OPENALEX_API_KEY=your-key`.

If the allowance does run out, the feeds are still read; Papers are picked up on the next run.

## Local model

Collection can run entirely on your Mac with [Ollama](https://ollama.com), at no cost.

1. Install Ollama (`brew install ollama`, or the app from ollama.com) and start it.
2. Download a model. The default is Qwen3 14B, which handles English, Chinese, Japanese and German well
   and needs about 10 GB of memory:
   ```sh
   ollama pull qwen3:14b
   ```
   With 32 GB or more, `qwen3:30b` judges better at a similar speed; set `RADAR_MODEL=qwen3:30b`.
3. In `.env`, set `RADAR_PROVIDER=ollama`. For a single run, use `--provider ollama` instead:
   ```sh
   npm run radar -- collect --limit 3 --provider ollama
   ```

A local model takes roughly 20–60 seconds per Entry on Apple silicon (long blog posts take the longest),
so the first full run (several hundred Entries) is best left overnight. After that, a day's new Entries
take minutes. Its Scores and summaries are rougher than Claude's; your 👍/👎 Votes help either way.

The run prints each Entry as it starts and how long it took. You can stop it at any time with Ctrl-C:
finished Entries are kept, and the rest wait for the next run.

If it is much slower than that, run `ollama ps` while it works. `PROCESSOR` should say `100% GPU`; if it
shows CPU, close other memory-hungry apps or use a smaller model. `qwen3:8b` is about twice as fast and
needs about 6 GB (`ollama pull qwen3:8b`, then `RADAR_MODEL=qwen3:8b`).

## Cost

With Claude, each new Entry is one request to Claude Haiku 5.5 (`claude-haiku-5-5`). A rough estimate for
this source list is $1–3 a month. To try a stronger model, set `RADAR_MODEL=claude-opus-5-5` in `.env`; it
judges better but costs about 40 times as much, which would break the $10 budget at full volume.

If the run hits an empty credit balance, a rejected key, a stopped Ollama or a model that isn't
downloaded, it stops at once and says how to fix it. Nothing is lost: the next run picks up every Entry
that wasn't assessed.

## Development

```sh
npm test            # unit and integration tests, no network or API key needed
npm run typecheck
```

The code follows the glossary's terms:

| File | What it does |
|---|---|
| `src/domain.ts` | Kinds, Statuses, Deadlines, Past, Series keys |
| `src/sources/` | Reading OpenAlex, RSS/Atom feeds and plain web pages into Entries |
| `src/assess.ts` | The shared schema and prompt (rubric, Kinds, Deadlines, Oxford English summaries), and the Claude provider |
| `src/ollama.ts`, `src/provider.ts` | The local Ollama provider, and choosing between the two |
| `src/radar.ts` | One collection run: dedupe, Versions, Series Votes, filing Items |
| `src/store.ts` | The SQLite archive (`data/radar.sqlite`) |
| `src/views.ts` | Thresholds and the deadline calendar |
| `src/server.ts`, `src/ui/` | The local dashboard |
