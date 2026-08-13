/**
 * StatsCache — a singleton Durable Object that owns all NFL data ingest.
 *
 * Source: nflverse-data GitHub releases. Free, no API key, no rate limit,
 * permissively licensed. Two assets are used:
 *
 *   rosters/roster_{season}.csv                  -> the draftable player pool
 *   stats_player/stats_player_week_{season}.csv  -> weekly stat lines
 *
 * Ingest is expensive (~0.5s CPU for a full season CSV), so it never runs on a
 * user request. A cron trigger drives it and requests only read cached blobs.
 */

import { parseCsv, num } from './csv.js';

const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';

/** Stat columns retained for scoring, in fixed positional order. */
export const STAT_COLS = [
  'passing_yards', 'passing_tds', 'passing_interceptions', 'passing_2pt_conversions',
  'carries', 'rushing_yards', 'rushing_tds', 'rushing_2pt_conversions',
  'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'receiving_2pt_conversions',
  'sack_fumbles_lost', 'rushing_fumbles_lost', 'receiving_fumbles_lost', 'special_teams_tds',
  'fg_made_0_19', 'fg_made_20_29', 'fg_made_30_39', 'fg_made_40_49', 'fg_made_50_59', 'fg_made_60_',
  'fg_missed', 'pat_made', 'pat_missed',
  'def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_tds', 'def_safeties',
];

const FANTASY_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];

/**
 * nflverse spells Arizona `AZ` in the roster files and `ARI` in the stats
 * files. Left unreconciled, the Cardinals defense silently scores zero every
 * week, so every team code is normalised to the roster spelling on ingest.
 */
const TEAM_ALIASES = { ARI: 'AZ' };
export function normalizeTeam(t) {
  return TEAM_ALIASES[t] || t;
}

/** Rehydrate a compact positional row back into a named object for scoring. */
export function inflate(row) {
  const o = { player_id: row[0], position: row[1], team: row[2] };
  for (let i = 0; i < STAT_COLS.length; i++) o[STAT_COLS[i]] = row[i + 3];
  return o;
}

export class StatsCache {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/pool') return json(await this.getPool());
      if (path === '/week') {
        const season = url.searchParams.get('season');
        const week = url.searchParams.get('week');
        return json((await this.ctx.storage.get(wkKey(season, week))) || null);
      }
      if (path === '/weeks') {
        const season = url.searchParams.get('season');
        return json((await this.ctx.storage.get(`weeks:${season}`)) || []);
      }
      if (path === '/rank') {
        const season = Number(url.searchParams.get('season'));
        let rank = await this.ctx.storage.get(`rank:${season}`);
        // Cold cache on first draft — pull the season we need on demand.
        if (!rank) {
          await this.ingestStats(season, { rankingsOnly: true });
          rank = await this.ctx.storage.get(`rank:${season}`);
        }
        return json(rank || null);
      }
      if (path === '/refresh') {
        const season = Number(url.searchParams.get('season')) || draftSeason();
        // `weeks=1` forces a full weekly ingest for that season — used to
        // backfill a completed season so its real box scores can be scored.
        if (url.searchParams.get('weeks') === '1') {
          return json(await this.ingestStats(season, {}));
        }
        const report = await this.refresh(season);
        return json(report);
      }
      if (path === '/meta') {
        return json({
          pool: await this.ctx.storage.get('pool:meta'),
          stats: await this.ctx.storage.get('stats:meta'),
        });
      }
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
    return json({ error: 'not found' }, 404);
  }

  /**
   * Serve the player pool, ingesting on first use if the cache is cold.
   * Keyed on the *draft* season — in August the stats season is still last
   * year, but the pool must reflect who is on a roster for the season ahead.
   */
  async getPool() {
    let pool = await this.ctx.storage.get('pool:data');
    if (!pool) {
      await this.ingestPool(draftSeason());
      pool = await this.ctx.storage.get('pool:data');
    }
    return pool || { players: [], meta: null };
  }

  /** Full refresh: player pool, prior-season rankings, and current-season weeks. */
  async refresh(season) {
    const report = { season, steps: [] };

    try {
      report.steps.push(await this.ingestPool(season));
    } catch (err) {
      report.steps.push({ step: 'pool', ok: false, error: String(err.message || err) });
    }

    // Prior season powers draft rankings before any 2026 games exist.
    try {
      report.steps.push(await this.ingestStats(season - 1, { rankingsOnly: true }));
    } catch (err) {
      report.steps.push({ step: `stats:${season - 1}`, ok: false, error: String(err.message || err) });
    }

    // Current season may 404 before kickoff — that is expected, not an error.
    try {
      report.steps.push(await this.ingestStats(season, {}));
    } catch (err) {
      report.steps.push({ step: `stats:${season}`, ok: false, error: String(err.message || err) });
    }

    await this.ctx.storage.put('stats:meta', { refreshedAt: Date.now(), season });
    return report;
  }

  /** Build the draftable player pool from the season roster file. */
  async ingestPool(season) {
    let res = await fetch(`${NFLVERSE}/rosters/roster_${season}.csv`, {
      headers: { 'user-agent': 'ff-league-worker' },
    });
    // Before a season's rosters publish, fall back to the prior year.
    let used = season;
    if (!res.ok) {
      used = season - 1;
      res = await fetch(`${NFLVERSE}/rosters/roster_${used}.csv`, {
        headers: { 'user-agent': 'ff-league-worker' },
      });
    }
    if (!res.ok) throw new Error(`roster fetch failed: ${res.status}`);

    const rows = parseCsv(await res.text());
    const h = rows[0];
    const ix = (n) => h.indexOf(n);
    const iPos = ix('position'), iStatus = ix('status'), iName = ix('full_name');
    const iTeam = ix('team'), iGsis = ix('gsis_id'), iShot = ix('headshot_url');
    const iJersey = ix('jersey_number'), iExp = ix('years_exp'), iDepth = ix('depth_chart_position');

    const seen = new Set();
    const players = [];
    for (let r = 1; r < rows.length; r++) {
      const c = rows[r];
      const pos = c[iPos];
      const id = c[iGsis];
      if (!id || seen.has(id)) continue;
      if (!FANTASY_POSITIONS.includes(pos)) continue;
      // ACT = active, RES = IR, but keep both so injured stars remain draftable.
      const status = c[iStatus] || '';
      if (status && !['ACT', 'RES', 'DEV', 'INA'].includes(status)) continue;

      seen.add(id);
      players.push({
        id,
        name: c[iName] || '',
        pos,
        team: c[iTeam] || 'FA',
        shot: c[iShot] || '',
        num: c[iJersey] || '',
        exp: num(c[iExp]),
        depth: c[iDepth] || pos,
      });
    }

    // Team defenses are draftable as synthetic players.
    const teams = [...new Set(players.map((p) => p.team))].filter((t) => t && t !== 'FA');
    for (const t of teams) {
      players.push({ id: `DST_${t}`, name: `${t} Defense`, pos: 'DST', team: t, shot: '', num: '', exp: 0, depth: 'DST' });
    }

    const meta = { season: used, count: players.length, at: Date.now() };
    await this.ctx.storage.put('pool:data', { players, meta });
    await this.ctx.storage.put('pool:meta', meta);
    return { step: 'pool', ok: true, ...meta };
  }

  /**
   * Ingest weekly stat lines for a season.
   * Stores one compact blob per week plus a season-total ranking table.
   */
  async ingestStats(season, { rankingsOnly = false }) {
    const res = await fetch(`${NFLVERSE}/stats_player/stats_player_week_${season}.csv`, {
      headers: { 'user-agent': 'ff-league-worker' },
    });
    if (res.status === 404) {
      return { step: `stats:${season}`, ok: true, skipped: 'not published yet' };
    }
    if (!res.ok) throw new Error(`stats fetch failed: ${res.status}`);

    const rows = parseCsv(await res.text());
    const h = rows[0];
    const ix = (n) => h.indexOf(n);
    const iId = ix('player_id'), iWk = ix('week'), iType = ix('season_type');
    const iPos = ix('position'), iTeam = ix('team'), iName = ix('player_display_name');
    const statIx = STAT_COLS.map(ix);

    const byWeek = new Map();
    const totals = new Map();

    for (let r = 1; r < rows.length; r++) {
      const c = rows[r];
      if (c[iType] !== 'REG') continue;

      const vals = new Array(statIx.length);
      let allZero = true;
      for (let i = 0; i < statIx.length; i++) {
        const raw = c[statIx[i]];
        const v = !raw || raw === 'NA' ? 0 : Number(raw) || 0;
        vals[i] = v;
        if (v !== 0) allZero = false;
      }
      // Linemen and inactives produce empty lines; drop them to stay small.
      if (allZero) continue;

      const id = c[iId];
      const week = c[iWk];
      const team = normalizeTeam(c[iTeam]);
      const rec = [id, c[iPos], team, ...vals];

      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week).push(rec);

      // Accumulate season totals for draft rankings.
      let t = totals.get(id);
      if (!t) {
        t = { id, name: c[iName], pos: c[iPos], team, g: 0, v: new Array(statIx.length).fill(0) };
        totals.set(id, t);
      }
      t.g++;
      for (let i = 0; i < vals.length; i++) t.v[i] += vals[i];
    }

    const weeks = [...byWeek.keys()].map(Number).sort((a, b) => a - b);

    if (!rankingsOnly) {
      for (const [week, list] of byWeek) {
        await this.ctx.storage.put(wkKey(season, week), {
          season: Number(season), week: Number(week), cols: STAT_COLS, rows: list, at: Date.now(),
        });
      }
      await this.ctx.storage.put(`weeks:${season}`, weeks);
    }

    // Rankings blob: season totals, used to sort the draft board.
    await this.ctx.storage.put(`rank:${season}`, {
      season, cols: STAT_COLS, at: Date.now(),
      rows: [...totals.values()].map((t) => [t.id, t.pos, t.team, t.g, t.name, ...t.v]),
    });

    return { step: `stats:${season}`, ok: true, weeks: weeks.length, players: totals.size };
  }
}

function wkKey(season, week) {
  return `wk:${season}:${Number(week)}`;
}

/** NFL seasons are labelled by their September start, so Jan–Aug belongs to the prior year. */
export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() < 8 ? y - 1 : y;
}

/** The season whose draft is upcoming — what an August league actually wants. */
export function draftSeason(now = new Date()) {
  return now.getUTCFullYear();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
