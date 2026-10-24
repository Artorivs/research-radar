# Research Radar

A personal radar for academic work. It reads papers, conferences, calls, courses, awards and jobs from
existing Sources, asks Claude how relevant each one is to your interests, and shows the results on a
dashboard on your Mac.

- **What it means by Item, Kind, Call, Series, Score and so on:** [GLOSSARY.md](GLOSSARY.md)
- **What was decided and why:** [DESIGN.md](DESIGN.md) and [docs/adr/](docs/adr/)

This is **build stage 1**: OpenAlex plus five blog feeds, scoring, and the dashboard. The weekly Digest,
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

- **Score** runs from −10 to +10. Items below 0, Past Items and Dismissed Items are hidden until you tick
  the boxes to show them.
- **⭐ Save** sets the Status to "saved". The Status menu offers the values that fit the Kind: read for
  Papers; submitted and attending for Events; applied for Calls, Courses, Awards and Jobs.
- **👍 / 👎** are Votes. The 30 most recent are shown to Claude with every new Entry, so scoring drifts
  towards your taste. A Vote on one edition of a recurring Event moves the next edition's Score by 2.
- **Dismiss** means "not for me now". It hides the Item but doesn't change future Scores.
- **Export deadlines (.ics)** downloads the Submission deadlines of Items you saved or that clear your
  thresholds, each with a reminder 14 days ahead. Times are stored in UTC and shown in your timezone.

## Sources

Edit [config/sources.json](config/sources.json) to add or remove feeds. Any RSS or Atom feed works.

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
| `src/sources/` | Reading OpenAlex and RSS/Atom feeds into Entries |
| `src/assess.ts` | The shared schema and prompt (rubric, Kinds, Deadlines, Oxford English summaries), and the Claude provider |
| `src/ollama.ts`, `src/provider.ts` | The local Ollama provider, and choosing between the two |
| `src/radar.ts` | One collection run: dedupe, Versions, Series Votes, filing Items |
| `src/store.ts` | The SQLite archive (`data/radar.sqlite`) |
| `src/views.ts` | Thresholds and the deadline calendar |
| `src/server.ts`, `src/ui/` | The local dashboard |
