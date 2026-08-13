#!/usr/bin/env node
/**
 * Regenerate src/season.json — a full real NFL season embedded in the page so
 * the standalone league can replay it week by week instead of simulating.
 *
 *   node fantasy-football/tools/build-season.mjs [season]
 *
 * Source: nflverse stats_player/stats_player_week_{season}.csv
 *
 * Only players in src/pool.json are kept, and only non-zero stat fields are
 * stored (about 12% of them), which takes the payload from ~287KB to ~120KB.
 * Component stats are stored rather than precomputed points so a league's own
 * scoring rules still apply.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../worker/src/csv.js';
import { normalizeTeam } from '../worker/src/stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const POOL = path.join(here, '..', 'src', 'pool.json');
const OUT = path.join(here, '..', 'src', 'season.json');
const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
const SEASON = Number(process.argv[2]) || pool.basis;

const poolIds = new Set(pool.players.filter((p) => p.p !== 'DST').map((p) => p.id));
const dstTeams = new Set(pool.players.filter((p) => p.p === 'DST').map((p) => p.t));

/** Stat columns kept, in fixed positional order — indexes are what get stored. */
const COLS = [
  'passing_yards', 'passing_tds', 'passing_interceptions', 'passing_2pt_conversions',
  'carries', 'rushing_yards', 'rushing_tds', 'rushing_2pt_conversions',
  'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'receiving_2pt_conversions',
  'sack_fumbles_lost', 'rushing_fumbles_lost', 'receiving_fumbles_lost', 'special_teams_tds',
  'fg_made_0_19', 'fg_made_20_29', 'fg_made_30_39', 'fg_made_40_49', 'fg_made_50_59', 'fg_made_60_',
  'fg_missed', 'pat_made', 'pat_missed',
  'def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_tds', 'def_safeties',
];

// Team-defense components, aggregated across every defender on a team.
const DST_COLS = ['def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_tds', 'def_safeties'];

process.stderr.write(`fetching stats_player_week_${SEASON}.csv\n`);
const res = await fetch(`${BASE}/stats_player/stats_player_week_${SEASON}.csv`);
if (!res.ok) throw new Error(`stats fetch failed: ${res.status}`);
const rows = parseCsv(await res.text());

const h = rows[0];
const ix = (n) => h.indexOf(n);
const iId = ix('player_id'), iWk = ix('week'), iType = ix('season_type'), iTeam = ix('team');
const iOpp = ix('opponent_team');
const colIx = COLS.map(ix);
const dstIx = DST_COLS.map(ix);

const weeks = {};        // week -> [ [id, fieldIdx, value, ...], ... ]
const dst = {};          // week -> team -> [sacks, ints, fumRec, tds, safeties]
const played = {};       // week -> Set(team) — used to detect bye weeks

let kept = 0;
for (let r = 1; r < rows.length; r++) {
  const c = rows[r];
  if (c[iType] !== 'REG') continue;
  const wk = Number(c[iWk]);
  const team = normalizeTeam(c[iTeam]);

  if (!played[wk]) played[wk] = new Set();
  if (team) played[wk].add(team);

  // Team defense: every player on the roster contributes, not just pool players.
  if (dstTeams.has(team)) {
    if (!dst[wk]) dst[wk] = {};
    if (!dst[wk][team]) dst[wk][team] = [0, 0, 0, 0, 0];
    for (let i = 0; i < dstIx.length; i++) {
      const v = c[dstIx[i]];
      dst[wk][team][i] += !v || v === 'NA' ? 0 : Number(v) || 0;
    }
  }

  const id = c[iId];
  if (!poolIds.has(id)) continue;

  const rec = [id];
  for (let i = 0; i < colIx.length; i++) {
    const raw = c[colIx[i]];
    const v = !raw || raw === 'NA' ? 0 : Number(raw) || 0;
    if (v !== 0) rec.push(i, v);      // sparse: field index then value
  }
  if (rec.length === 1) continue;      // played but did nothing scorable
  if (!weeks[wk]) weeks[wk] = [];
  weeks[wk].push(rec);
  kept++;
}

// Drop trailing all-zero defense entries to keep the payload tight.
for (const wk of Object.keys(dst)) {
  for (const t of Object.keys(dst[wk])) {
    if (dst[wk][t].every((v) => v === 0)) delete dst[wk][t];
    else dst[wk][t] = dst[wk][t].map((v) => Math.round(v * 10) / 10);
  }
}

const weekNums = Object.keys(weeks).map(Number).sort((a, b) => a - b);
const out = {
  season: SEASON,
  cols: COLS,
  dstCols: DST_COLS,
  weeks,
  dst,
  // Which teams were on bye each week, so the UI can label a 0 correctly.
  teams: [...dstTeams].sort(),
  byes: Object.fromEntries(weekNums.map((w) => [w, [...dstTeams].filter((t) => !played[w].has(t)).sort()])),
};

fs.writeFileSync(OUT, JSON.stringify(out));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${SEASON} season, ${weekNums.length} weeks, ${kept} player-weeks, ${kb}KB`);
console.log('byes per week:', weekNums.map((w) => `${w}:${out.byes[w].length}`).join(' '));
