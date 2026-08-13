#!/usr/bin/env node
/**
 * Regenerate src/pool.json — the player pool embedded in the standalone page.
 *
 *   node fantasy-football/tools/build-pool.mjs [draftSeason]
 *
 * Sources (both free, no API key, from nflverse open data):
 *   rosters/roster_{season}.csv                  — who is on a roster, and where
 *   stats_player/stats_player_week_{season-1}.csv — last season's production
 *
 * Players are ranked by Value Over Replacement rather than raw points, so the
 * board drafts the way a real one does instead of taking ten quarterbacks first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num } from '../worker/src/csv.js';
import { scoreStatLine, SCORING_PRESETS, round2 } from '../worker/src/scoring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'src', 'pool.json');
const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

const DRAFT_SEASON = Number(process.argv[2]) || new Date().getUTCFullYear();
const STAT_SEASON = DRAFT_SEASON - 1;

const FANTASY_POS = ['QB', 'RB', 'WR', 'TE', 'K'];
const TEAMS_ASSUMED = 10;
// Starters per position for a standard lineup; RB/WR are inflated because FLEX
// pulls from them, which is what makes replacement level land in the right spot.
const STARTERS = { QB: 1, RB: 2.5, WR: 3.5, TE: 1.2, K: 1 };
const TOP_N = 280;
const DST_PPG = 8.0;   // defenses are streamed; a flat average keeps the UI honest

async function grab(url) {
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const rosterCsv = await grab(`${BASE}/rosters/roster_${DRAFT_SEASON}.csv`)
  .catch(() => grab(`${BASE}/rosters/roster_${DRAFT_SEASON - 1}.csv`));
const statsCsv = await grab(`${BASE}/stats_player/stats_player_week_${STAT_SEASON}.csv`);

// ---- identity and team come from the roster file
const R = parseCsv(rosterCsv);
const rh = R[0], rix = (n) => rh.indexOf(n);
const roster = new Map();
for (let i = 1; i < R.length; i++) {
  const c = R[i];
  const id = c[rix('gsis_id')];
  if (!id || roster.has(id)) continue;
  roster.set(id, {
    name: c[rix('full_name')], pos: c[rix('position')], team: c[rix('team')],
    shot: c[rix('headshot_url')] || '', num: c[rix('jersey_number')] || '',
  });
}

// ---- production comes from last season's weekly stats
const X = parseCsv(statsCsv);
const xh = X[0];
const agg = new Map();
for (let i = 1; i < X.length; i++) {
  const row = {};
  xh.forEach((k, j) => (row[k] = X[i][j]));
  if (row.season_type !== 'REG') continue;
  const id = row.player_id;
  if (!id) continue;
  const pts = scoreStatLine(row, SCORING_PRESETS.half_ppr).points;
  let a = agg.get(id);
  if (!a) { a = { id, name: row.player_display_name, pos: row.position, g: 0, pts: 0 }; agg.set(id, a); }
  a.g++;
  a.pts += pts;
}

const list = [];
for (const [id, a] of agg) {
  const r = roster.get(id);
  if (!r) continue;                       // retired or unsigned — not draftable
  const pos = r.pos || a.pos;
  if (!FANTASY_POS.includes(pos)) continue;
  if (a.g < 3) continue;                  // too small a sample to rank on
  list.push({
    id, n: r.name, p: pos, t: r.team, g: a.g,
    pts: round2(a.pts), ppg: round2(a.pts / a.g),
    s: r.shot, j: r.num,
  });
}

// ---- Value Over Replacement
const byPos = {};
for (const p of list) (byPos[p.p] = byPos[p.p] || []).push(p);
const repl = {};
for (const pos of FANTASY_POS) {
  const arr = (byPos[pos] || []).sort((a, b) => b.ppg - a.ppg);
  // Kickers are streamed, not drafted: replacement is the 3rd-best K, which
  // collapses their value toward zero and pushes them to the back of the board.
  const n = pos === 'K' ? 3 : Math.round(TEAMS_ASSUMED * STARTERS[pos]);
  repl[pos] = arr.length ? arr[Math.min(arr.length - 1, Math.max(0, n - 1))].ppg : 0;
}
for (const p of list) p.v = round2(p.ppg - repl[p.p]);

list.sort((a, b) => b.v - a.v);
const players = list.slice(0, TOP_N);

// ---- team defenses, drafted late like kickers
const teams = [...new Set([...roster.values()].map((r) => r.team))]
  .filter((t) => t && t.length <= 3).sort();
for (const t of teams) {
  players.push({ id: 'DST_' + t, n: `${t} Defense`, p: 'DST', t, g: 17, pts: round2(DST_PPG * 17), ppg: DST_PPG, s: '', j: '', v: -0.5 });
}
players.forEach((p, i) => (p.r = i + 1));

const out = { season: DRAFT_SEASON, basis: STAT_SEASON, scoring: 'half_ppr', teams, players };
fs.writeFileSync(OUT, JSON.stringify(out));

console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${players.length} players, ${(fs.statSync(OUT).size / 1024).toFixed(1)}KB`);
console.log('replacement ppg:', repl);
console.log('top 10:', players.slice(0, 10).map((p) => `${p.p} ${p.n}`).join(', '));
