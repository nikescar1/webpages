# Gridiron — fantasy football

A complete fantasy football league in one self-contained HTML file, with an
optional Cloudflare Worker backend for shared multiplayer and live NFL scoring.

**[▶ Play it](https://nikescar1.github.io/webpages/fantasy-football.html)**

---

## Two ways to run it

|                        | Local (no setup)                          | Shared (Cloudflare)                  |
| ---------------------- | ----------------------------------------- | ------------------------------------ |
| Setup                  | Open the file                             | `wrangler deploy`                    |
| Opponents              | CPU managers                              | Real people, live                    |
| Draft                  | Live snake draft vs bots                  | Live snake draft, WebSocket-synced   |
| Accounts               | None                                      | Email + password                     |
| Weekly scoring         | **Replays the real 2025 season**, or sims | Live NFL box scores                  |
| Playoffs               | Top 4, semis + final                      | Regular season                       |
| Data leaves the device | Never                                     | Only to your own Worker              |

The page works fully on its own — that is the point of the single file. The
Worker upgrades it; it is not required.

## Replaying a real season

Pick **Replay the real 2025 season** at league creation (the default) and every
week is scored from the actual 2025 box scores embedded in the page. Nothing is
randomised: real bye weeks, real injuries, real 40-point Sundays. Draft
Christian McCaffrey and you get exactly the season he had.

A season runs **14 regular-season weeks, then a four-team playoff** — semifinals
in week 15, the championship in week 16 — mapped onto the real NFL weeks of the
same number. "Sim to end of season" plays the whole thing at once and crowns a
champion with the trophy ceremony.

For small leagues the round robin is shorter than 14 weeks, so the rotation
repeats, which is what real leagues do. The other mode simulates results from
each player's season average with position-appropriate variance, seeded so a
given week always scores the same.

---

## Where the numbers come from

All player data is [nflverse](https://github.com/nflverse) open data. Free, no
API key, no rate limit, no licensing problem.

| What | Source |
| --- | --- |
| Draftable players, teams, headshots | `rosters/roster_2026.csv` |
| Prior-season production, and the replayable season | `stats_player/stats_player_week_2025.csv` |
| Live weekly box scores | `stats_player/stats_player_week_2026.csv` (appears at kickoff) |

Three details worth knowing:

- **Rankings use value over replacement, not raw points.** Ranking by total
  points puts eight quarterbacks in the top fifteen. Replacement level is the
  last startable player at each position, so the board drafts the way a real one
  does. Kickers and defenses are treated as streamed, which lands them in the
  last two rounds instead of round three.
- **The scoring engine was verified against nflverse's own numbers** — 12,428
  player-weeks across 2024 and 2025, zero mismatches. See `worker/src/scoring.js`.
  The page inlines that same file rather than reimplementing it, so a replayed
  week scores identically in the browser and on the edge.
- **nflverse spells Arizona `AZ` in roster files and `ARI` in stat files.** Left
  unreconciled the Cardinals defense scores zero every week, so team codes are
  normalised on ingest.

Browsers cannot fetch nflverse directly (its release downloads send no CORS
header), which is exactly why the standalone page embeds a player snapshot and
the Worker proxies everything else.

---

## Deploying the backend

Durable Objects here are SQLite-backed, so this runs on the **Workers free plan**.

```bash
cd fantasy-football/worker
npm install

# Sign the session tokens with a real secret — without this the Worker falls
# back to a well-known development string and anyone could forge a session.
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET

npx wrangler deploy
```

Deploy prints a URL like `https://ff-league.<your-subdomain>.workers.dev`. Open
the page, choose **Shared league**, paste that URL, and register.

Then warm the data cache once (the hourly cron does this from then on):

```bash
curl "https://ff-league.<you>.workers.dev/api/admin/refresh?key=<SESSION_SECRET>"
```

Optionally lock down CORS in `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://nikescar1.github.io"
```

### Before the season starts

Until the 2026 season kicks off there are no box scores, and "play week" will
say so rather than inventing results. To try real scoring immediately, backfill
a finished season:

```bash
curl "https://.../api/admin/refresh?key=<SECRET>&season=2025&weeks=1"
```

…then create a league with `season: 2025`.

---

## How it fits together

```
fantasy-football.html          ← the deliverable: one file, no build, no deps
  ├── three.js r160 (inlined)
  ├── player pool (inlined JSON)
  └── app + 3D scenes

fantasy-football/
  ├── build.mjs                → assembles the html from src/
  ├── src/                     → edit these, not the built file
  │   ├── app.js               app logic, views, local league engine
  │   ├── app.css              design tokens + all styling
  │   ├── three-scenes.js      trophy ceremony, hero field, pick burst
  │   ├── shell.html           page skeleton
  │   ├── pool.json            generated player data
  │   └── season.json          generated: a full real season, for replay mode
  ├── tools/build-pool.mjs     → regenerates pool.json from nflverse
  ├── tools/build-season.mjs   → regenerates season.json from nflverse
  └── worker/                  → Cloudflare Worker
      ├── src/index.js         router, auth, CORS, cron
      ├── src/league.js        LeagueRoom DO — draft, lineups, scoring, WebSocket
      ├── src/registry.js      UserRegistry DO — accounts, invite codes
      ├── src/stats.js         StatsCache DO — nflverse ingest
      ├── src/scoring.js       scoring rules (shared, pure, tested)
      └── src/csv.js           RFC4180 parser
```

Rebuild after editing anything in `src/`:

```bash
node fantasy-football/build.mjs
```

### Design notes

- **One Durable Object per league** is what makes a concurrent snake draft
  correct. Every pick for a league is serialized through a single object, so
  there is no locking and no double-drafting a player.
- **The pick clock is a DO alarm**, not a client timer, so a manager who closes
  their laptop still gets auto-drafted from their queue.
- **Ingest never runs on a user request.** Parsing a season CSV costs ~0.5s of
  CPU, far past a request budget, so an hourly cron does it and requests only
  read cached blobs. Weekly data is stored as compact positional arrays —
  40KB per week rather than 147KB, which also keeps it under the 128KB
  Durable Object value limit.
- **WebSocket hibernation** means an idle league between Sundays costs nothing.
- **The embedded season is stored sparsely** — only the ~12% of stat fields that
  are non-zero, which is 130KB instead of 287KB. Component stats are stored
  rather than precomputed points, so a league's own scoring rules still apply.

---

## Scoring

Half PPR by default; standard, full PPR, and PPR-with-bonuses are selectable at
league creation. Passing 1/25yd and 4/TD, rushing and receiving 1/10yd and
6/TD, −2 interceptions and fumbles lost, kickers by distance bucket (3/4/5).

Team defenses score the event half of D/ST — sacks, takeaways, defensive
touchdowns, safeties. Points-allowed and yards-allowed tiers are team-level
figures that the player stat file does not carry, so they are not included.

---

## Credits

Player data from [nflverse](https://github.com/nflverse/nflverse-data)
(MIT). 3D by [three.js](https://threejs.org) r160. Player headshots are loaded
from NFL.com and degrade to initials when unavailable.
