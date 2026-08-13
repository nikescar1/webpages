/**
 * Fantasy scoring engine.
 *
 * Operates on nflverse `stats_player_week_{season}.csv` rows (the `stats_player`
 * release). Column names below are taken from that schema verbatim — note it
 * uses `passing_interceptions`, not the older `interceptions` from the
 * retired `player_stats` release.
 */

import { num } from './csv.js';

/** Default ruleset: half-PPR, the most common modern league default. */
export const DEFAULT_RULES = {
  // Passing
  passYdsPerPoint: 25,
  passTd: 4,
  passInt: -2,
  pass2pt: 2,
  passBonus300: 0,

  // Rushing
  rushYdsPerPoint: 10,
  rushTd: 6,
  rush2pt: 2,
  rushBonus100: 0,

  // Receiving
  recYdsPerPoint: 10,
  recTd: 6,
  rec2pt: 2,
  perReception: 0.5,
  recBonus100: 0,

  // Misc
  fumbleLost: -2,
  specialTeamsTd: 6,

  // Kicking — by distance bucket
  fg0_39: 3,
  fg40_49: 4,
  fg50plus: 5,
  fgMissed: -1,
  pat: 1,
  patMissed: -1,

  // Individual defense (used for D/ST aggregation too)
  defSack: 1,
  defInt: 2,
  defFumbleRec: 2,
  defTd: 6,
  defSafety: 2,
};

export const SCORING_PRESETS = {
  standard: { ...DEFAULT_RULES, perReception: 0 },
  half_ppr: { ...DEFAULT_RULES, perReception: 0.5 },
  ppr: { ...DEFAULT_RULES, perReception: 1 },
  ppr_bonus: {
    ...DEFAULT_RULES,
    perReception: 1,
    passBonus300: 3,
    rushBonus100: 3,
    recBonus100: 3,
  },
};

/**
 * Score a single weekly stat line.
 * Returns total points rounded to 2dp, plus a breakdown for the UI.
 */
export function scoreStatLine(row, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...rules };
  const parts = [];
  let total = 0;

  const add = (label, pts) => {
    if (pts === 0) return;
    total += pts;
    parts.push({ label, pts: round2(pts) });
  };

  // ---- Passing
  const passYds = num(row.passing_yards);
  if (passYds) add('Pass yds', passYds / r.passYdsPerPoint);
  add('Pass TD', num(row.passing_tds) * r.passTd);
  add('INT', num(row.passing_interceptions) * r.passInt);
  add('Pass 2PT', num(row.passing_2pt_conversions) * r.pass2pt);
  if (r.passBonus300 && passYds >= 300) add('300yd bonus', r.passBonus300);

  // ---- Rushing
  const rushYds = num(row.rushing_yards);
  if (rushYds) add('Rush yds', rushYds / r.rushYdsPerPoint);
  add('Rush TD', num(row.rushing_tds) * r.rushTd);
  add('Rush 2PT', num(row.rushing_2pt_conversions) * r.rush2pt);
  if (r.rushBonus100 && rushYds >= 100) add('100yd rush bonus', r.rushBonus100);

  // ---- Receiving
  const recYds = num(row.receiving_yards);
  const rec = num(row.receptions);
  if (rec) add('Rec', rec * r.perReception);
  if (recYds) add('Rec yds', recYds / r.recYdsPerPoint);
  add('Rec TD', num(row.receiving_tds) * r.recTd);
  add('Rec 2PT', num(row.receiving_2pt_conversions) * r.rec2pt);
  if (r.recBonus100 && recYds >= 100) add('100yd rec bonus', r.recBonus100);

  // ---- Turnovers. nflverse splits fumbles lost across three columns by the
  // play type that caused them; a player can lose fumbles in more than one.
  const fumblesLost =
    num(row.sack_fumbles_lost) +
    num(row.rushing_fumbles_lost) +
    num(row.receiving_fumbles_lost);
  add('Fumble lost', fumblesLost * r.fumbleLost);

  add('ST TD', num(row.special_teams_tds) * r.specialTeamsTd);

  // ---- Kicking
  const fgShort = num(row.fg_made_0_19) + num(row.fg_made_20_29) + num(row.fg_made_30_39);
  const fgMid = num(row.fg_made_40_49);
  const fgLong = num(row.fg_made_50_59) + num(row['fg_made_60_']);
  add('FG 0-39', fgShort * r.fg0_39);
  add('FG 40-49', fgMid * r.fg40_49);
  add('FG 50+', fgLong * r.fg50plus);
  add('FG miss', num(row.fg_missed) * r.fgMissed);
  add('PAT', num(row.pat_made) * r.pat);
  add('PAT miss', num(row.pat_missed) * r.patMissed);

  // ---- Individual defense
  add('Sack', num(row.def_sacks) * r.defSack);
  add('Def INT', num(row.def_interceptions) * r.defInt);
  add('Fum rec', num(row.fumble_recovery_opp) * r.defFumbleRec);
  add('Def TD', num(row.def_tds) * r.defTd);
  add('Safety', num(row.def_safeties) * r.defSafety);

  return { points: round2(total), parts };
}

/**
 * Aggregate a team's defensive players into a single D/ST line.
 *
 * Caveat worth knowing: real D/ST scoring includes points-allowed and
 * yards-allowed tiers, which are team-level and absent from the player file.
 * This covers the event-driven half (sacks, takeaways, TDs, safeties).
 */
export function scoreTeamDefense(teamRows, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...rules };
  let sacks = 0, ints = 0, fumRec = 0, tds = 0, safeties = 0;

  for (const row of teamRows) {
    sacks += num(row.def_sacks);
    ints += num(row.def_interceptions);
    fumRec += num(row.fumble_recovery_opp);
    tds += num(row.def_tds);
    safeties += num(row.def_safeties);
  }

  const parts = [];
  let total = 0;
  const add = (label, pts) => {
    if (pts === 0) return;
    total += pts;
    parts.push({ label, pts: round2(pts) });
  };

  add('Sacks', sacks * r.defSack);
  add('INT', ints * r.defInt);
  add('Fum rec', fumRec * r.defFumbleRec);
  add('Def TD', tds * r.defTd);
  add('Safety', safeties * r.defSafety);

  return { points: round2(total), parts };
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Roster slot definitions. `accepts` lists eligible player positions. */
export const SLOTS = {
  QB: { label: 'QB', accepts: ['QB'] },
  RB: { label: 'RB', accepts: ['RB'] },
  WR: { label: 'WR', accepts: ['WR'] },
  TE: { label: 'TE', accepts: ['TE'] },
  FLEX: { label: 'FLEX', accepts: ['RB', 'WR', 'TE'] },
  SUPERFLEX: { label: 'SUPERFLEX', accepts: ['QB', 'RB', 'WR', 'TE'] },
  K: { label: 'K', accepts: ['K'] },
  DST: { label: 'D/ST', accepts: ['DST'] },
  BENCH: { label: 'BE', accepts: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] },
};

/** Default starting lineup: 1QB, 2RB, 2WR, 1TE, 1FLEX, 1K, 1DST + 6 bench. */
export const DEFAULT_ROSTER = {
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6,
};

/** Expand a roster spec into an ordered list of concrete slot ids. */
export function expandRoster(spec = DEFAULT_ROSTER) {
  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST', 'BENCH'];
  const slots = [];
  for (const kind of order) {
    const n = spec[kind] || 0;
    for (let i = 0; i < n; i++) {
      slots.push({ id: `${kind}${i + 1}`, kind, starter: kind !== 'BENCH' });
    }
  }
  return slots;
}

export function slotAccepts(kind, position) {
  const def = SLOTS[kind];
  return !!def && def.accepts.includes(position);
}
