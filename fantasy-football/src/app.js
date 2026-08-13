/* ============================================================================
   Gridiron — fantasy football league
   Runs standalone (local league, embedded player data) and upgrades to a
   shared multiplayer league when a Cloudflare Worker URL is configured.
   ========================================================================== */

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape untrusted text — team names and chat are user-authored. */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

function el(tag, attrs = {}, html = '') {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  if (html) n.innerHTML = html;
  return n;
}

function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, esc(msg));
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 320);
  }, 2800);
}

/** Deterministic PRNG so simulated weeks are stable across reloads and views. */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Box-Muller, for realistic weekly variance around a player's average. */
function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* -------------------------------------------------------------- player pool */

const POOL = window.__POOL__;
const PLAYERS = new Map(POOL.players.map((p) => [p.id, p]));
const player = (id) => PLAYERS.get(id) || { id, n: 'Unknown', p: '??', t: '', ppg: 0, v: 0, r: 999 };

/* ------------------------------------------------------- real season replay */

const SEASON = window.__SEASON__ || null;

/** Season shape: 14 regular-season weeks, then a 4-team, 2-round playoff. */
const REG_WEEKS = 14;
const SEMI_WEEK = 15;
const FINAL_WEEK = 16;
const LAST_WEEK = FINAL_WEEK;

/**
 * Lazily inflate a week's sparse stat rows into lookup maps.
 * Rows are [playerId, fieldIndex, value, fieldIndex, value, ...].
 */
const seasonCache = {};
function seasonWeek(week) {
  if (!SEASON) return null;
  if (seasonCache[week]) return seasonCache[week];

  const rows = SEASON.weeks[week];
  const byPlayer = new Map();
  if (rows) {
    for (const rec of rows) {
      const line = {};
      for (let i = 1; i < rec.length; i += 2) line[SEASON.cols[rec[i]]] = rec[i + 1];
      byPlayer.set(rec[0], line);
    }
  }

  const byDst = new Map();
  const d = SEASON.dst[week] || {};
  for (const [team, vals] of Object.entries(d)) {
    const line = {};
    SEASON.dstCols.forEach((c, i) => (line[c] = vals[i]));
    byDst.set(team, line);
  }

  seasonCache[week] = { byPlayer, byDst, byes: new Set(SEASON.byes[week] || []) };
  return seasonCache[week];
}

/** The real stat line a player posted that week, or null if he did not play. */
function realLine(week, playerId) {
  const wk = seasonWeek(week);
  if (!wk) return null;
  if (playerId.startsWith('DST_')) return wk.byDst.get(playerId.slice(4)) || null;
  return wk.byPlayer.get(playerId) || null;
}

function onBye(week, playerId) {
  const wk = seasonWeek(week);
  if (!wk) return false;
  const team = playerId.startsWith('DST_') ? playerId.slice(4) : player(playerId).t;
  return wk.byes.has(team);
}

/** Map a league week onto a real NFL week (playoff weeks map straight through). */
function nflWeek(week) {
  return week;
}

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

// DEFAULT_ROSTER, expandRoster, slotAccepts, SCORING_PRESETS and scoreStatLine
// come from the Worker's scoring module, inlined just above this script.

const SCORING_LABELS = {
  standard: 'Standard (no PPR)',
  half_ppr: 'Half PPR (0.5 / catch)',
  ppr: 'Full PPR (1 / catch)',
  ppr_bonus: 'PPR + yardage bonuses',
};

/* --------------------------------------------------------------- app state */

const S = {
  view: 'draft',
  league: null,
  myTeamId: null,
  mode: 'local',            // 'local' | 'cloud'
  api: localStorage.getItem('gi.api') || '',
  token: localStorage.getItem('gi.token') || '',
  user: JSON.parse(localStorage.getItem('gi.user') || 'null'),
  ws: null,
  filter: { pos: 'ALL', q: '', sort: 'v' },
  week: 1,
  ticker: [],
  lastPickCount: 0,
};

const isCloud = () => S.mode === 'cloud';
const myTeam = () => S.league?.teams.find((t) => t.id === S.myTeamId) || null;
const isCommish = () => S.league && (isCloud()
  ? S.league.commissionerId === S.user?.id
  : S.league.commissionerId === 'local-user');

/* ================================================================ LocalLeague
   A faithful client-side mirror of the Worker's LeagueRoom so the page is
   fully playable before any backend exists. Same shapes, same rules.
   ========================================================================= */

const TEAM_COLORS = ['#ff4d6d', '#4cc9f0', '#f7b801', '#7ae582', '#b892ff', '#ff8fab',
  '#00d4a0', '#ff9f1c', '#5390d9', '#f72585', '#48cae4', '#c77dff'];

const BOT_NAMES = ['Gridiron Gang', 'End Zone Elite', 'Pocket Pressure', 'Blitz Brigade',
  'Hail Mary Inc', 'Play Action', 'Red Zone Rebels', 'Fourth & Goal', 'Two Minute Drill',
  'Pylon Pushers', 'Audible Army', 'Sack Exchange'];

const Local = {
  key: 'gi.league.local',

  load() {
    try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { return null; }
  },
  save(lg) { localStorage.setItem(this.key, JSON.stringify(lg)); },
  clear() { localStorage.removeItem(this.key); },

  create({ name, teamName, managerName, teamCount, scoring, pickSeconds, roster, dataMode }) {
    // Replay uses the real season's results; sim rolls them from each player's
    // average. Replay is only offered when the season data is actually present.
    const mode = SEASON && dataMode !== 'sim' ? 'replay' : 'sim';
    const lg = {
      id: 'local', code: 'SOLO', name: name || 'My League',
      commissionerId: 'local-user',
      settings: {
        season: mode === 'replay' ? SEASON.season : POOL.season,
        scoring: scoring || 'half_ppr',
        rules: SCORING_PRESETS[scoring || 'half_ppr'],
        roster: roster || DEFAULT_ROSTER,
        teamCount: teamCount || 10, pickSeconds: pickSeconds || 45,
        rounds: expandRoster(roster || DEFAULT_ROSTER).length,
        dataMode: mode,
      },
      teams: [], draft: { status: 'pre', order: [], picks: [], current: null, queues: {} },
      lineups: {}, schedule: null, results: {}, currentWeek: 1, chat: [],
      playoffs: null, champion: null,
      local: true,
    };

    lg.teams.push({
      id: 'T0', userId: 'local-user', owner: managerName || 'You',
      name: teamName || 'My Team', color: TEAM_COLORS[0],
      roster: [], slots: {}, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, bot: false,
    });
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 1; i < lg.settings.teamCount; i++) {
      lg.teams.push({
        id: 'T' + i, userId: 'bot-' + i, owner: 'CPU', name: names[i - 1] || 'Team ' + i,
        color: TEAM_COLORS[i % TEAM_COLORS.length],
        roster: [], slots: {}, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, bot: true,
      });
    }
    this.save(lg);
    return lg;
  },

  startDraft(lg) {
    lg.draft.order = [...lg.teams.map((t) => t.id)].sort(() => Math.random() - 0.5);
    lg.draft.picks = [];
    lg.draft.status = 'live';
    lg.draft.current = this.nextSlot(lg, 0);
    this.save(lg);
    return lg;
  },

  nextSlot(lg, overall) {
    const n = lg.draft.order.length;
    const total = n * lg.settings.rounds;
    if (overall >= total) return null;
    const round = Math.floor(overall / n) + 1;
    const pos = overall % n;
    const idx = round % 2 === 1 ? pos : n - 1 - pos;
    return {
      overall: overall + 1, round, pickInRound: pos + 1,
      teamId: lg.draft.order[idx],
      deadline: Date.now() + lg.settings.pickSeconds * 1000,
    };
  },

  pick(lg, teamId, playerId) {
    const cur = lg.draft.current;
    if (!cur || cur.teamId !== teamId) return { error: 'Not on the clock.' };
    const taken = new Set(lg.draft.picks.map((p) => p.playerId));
    let chosen = playerId;
    if (!chosen || taken.has(chosen)) chosen = this.bestAvailable(lg, teamId, taken);
    if (!chosen) return { error: 'No players left.' };

    const team = lg.teams.find((t) => t.id === teamId);
    lg.draft.picks.push({
      overall: cur.overall, round: cur.round, pickInRound: cur.pickInRound,
      teamId, playerId: chosen, at: Date.now(), auto: chosen !== playerId,
    });
    team.roster.push(chosen);
    lg.draft.queues[teamId] = (lg.draft.queues[teamId] || []).filter((id) => id !== chosen);
    lg.draft.current = this.nextSlot(lg, lg.draft.picks.length);

    if (!lg.draft.current) {
      lg.draft.status = 'done';
      this.autoLineups(lg);
      lg.schedule = buildSeasonSchedule(lg.teams.map((t) => t.id));
    }
    this.save(lg);
    return { ok: true, playerId: chosen };
  },

  /** Bot logic: best value available, nudged toward unfilled starting slots. */
  bestAvailable(lg, teamId, taken) {
    const team = lg.teams.find((t) => t.id === teamId);
    const owned = new Set(team.roster);
    const counts = {};
    for (const id of team.roster) { const p = player(id); counts[p.p] = (counts[p.p] || 0) + 1; }

    const slots = expandRoster(lg.settings.roster).filter((s) => s.starter);
    const want = {};
    for (const pos of POSITIONS) want[pos] = slots.filter((s) => slotAccepts(s.kind, pos)).length;

    let best = null, bestScore = -1e9;
    for (const p of POOL.players) {
      if (taken.has(p.id) || owned.has(p.id)) continue;
      const have = counts[p.p] || 0;
      let score = p.v;
      // Strongly prefer positions we still need to start.
      if (have < (want[p.p] || 0)) score += 3.2;
      // Discourage hoarding one position.
      if (have >= (want[p.p] || 0) + 2) score -= 4.5;
      // Nobody drafts a K or DST early.
      if ((p.p === 'K' || p.p === 'DST') && lg.draft.picks.length < lg.teams.length * (lg.settings.rounds - 2)) {
        score -= 9;
      }
      score += (Math.random() - 0.5) * 1.4; // a little human noise
      if (score > bestScore) { bestScore = score; best = p.id; }
    }
    return best;
  },

  autoLineups(lg) {
    // Only starting slots are recorded; anyone unassigned is on the bench.
    const slots = expandRoster(lg.settings.roster).filter((s) => s.starter);
    for (const team of lg.teams) {
      const byVal = [...team.roster].sort((a, b) => player(b).v - player(a).v);
      const used = new Set();
      team.slots = {};
      for (const s of slots) {
        for (const id of byVal) {
          if (used.has(id)) continue;
          if (!slotAccepts(s.kind, player(id).p)) continue;
          team.slots[s.id] = id; used.add(id); break;
        }
      }
    }
  },

  /**
   * Simulated weekly stat line, seeded by (league, week, player) so every
   * render agrees. Cloud mode replaces this with real nflverse results.
   */
  simulate(lg, week, playerId) {
    const p = player(playerId);
    const rand = mulberry32(hashStr(`${lg.id}|${lg.settings.season}|${week}|${playerId}`));
    const base = p.ppg || 4;
    // Position-specific volatility: RB/WR swing far more than QB or K.
    const sigma = { QB: 0.28, RB: 0.45, WR: 0.52, TE: 0.48, K: 0.34, DST: 0.55 }[p.p] || 0.45;
    let pts = base * (1 + gauss(rand) * sigma);
    if (rand() < 0.045) pts *= 0.18;          // injury / early exit
    if (rand() < 0.05) pts += base * 0.85;    // boom game
    if (p.p === 'DST') pts = 4 + rand() * 12;
    return Math.max(0, Math.round(pts * 10) / 10);
  },

  /** Points for one player in one week, from real results or simulation. */
  pointsFor(lg, week, playerId) {
    if (lg.settings.dataMode !== 'replay') return this.simulate(lg, week, playerId);
    const line = realLine(nflWeek(week), playerId);
    if (!line) return 0;   // bye, inactive, or did nothing scorable
    return scoreStatLine(line, lg.settings.rules).points;
  },

  /** The pairings for a week — regular-season schedule, or the playoff bracket. */
  pairsFor(lg, week) {
    if (week > REG_WEEKS) return (lg.playoffs && lg.playoffs.bracket[week]) || [];
    return (lg.schedule && lg.schedule[week - 1]) || [];
  },

  scoreWeek(lg, week) {
    const slots = expandRoster(lg.settings.roster);
    const starters = new Set(slots.filter((s) => s.starter).map((s) => s.id));
    const pairs = this.pairsFor(lg, week);
    // In the playoffs only the teams still alive post a score.
    const alive = week > REG_WEEKS ? new Set(pairs.flat()) : null;

    const scores = {};
    for (const team of lg.teams) {
      if (alive && !alive.has(team.id)) continue;
      const lineup = (lg.lineups[week] && lg.lineups[week][team.id]) || team.slots || {};
      let total = 0; const detail = [];
      for (const [slotId, pid] of Object.entries(lineup)) {
        if (!starters.has(slotId) || !pid) continue;
        const pts = this.pointsFor(lg, week, pid);
        total += pts;
        detail.push({ slotId, playerId: pid, points: pts, bye: lg.settings.dataMode === 'replay' && onBye(nflWeek(week), pid) });
      }
      scores[team.id] = { total: Math.round(total * 10) / 10, detail };
    }

    const matchups = pairs.map(([a, b]) => {
      const sa = scores[a]?.total || 0, sb = scores[b]?.total || 0;
      return { home: a, away: b, homePts: sa, awayPts: sb, winner: sa === sb ? null : (sa > sb ? a : b) };
    });
    lg.results[week] = {
      scores, matchups, at: Date.now(),
      recorded: lg.results[week]?.recorded || false,
      playoff: week > REG_WEEKS,
    };
    this.save(lg);
    return lg.results[week];
  },

  /** Top four by record (points for breaks ties) meet in week 15. */
  seedPlayoffs(lg) {
    const ranked = [...lg.teams].sort((a, b) => {
      const wa = a.wins + a.ties * 0.5, wb = b.wins + b.ties * 0.5;
      return wb !== wa ? wb - wa : b.pf - a.pf;
    });
    const seeds = ranked.slice(0, Math.min(4, lg.teams.length)).map((t) => t.id);
    const bracket = {};
    if (seeds.length >= 4) bracket[SEMI_WEEK] = [[seeds[0], seeds[3]], [seeds[1], seeds[2]]];
    else if (seeds.length >= 2) bracket[FINAL_WEEK] = [[seeds[0], seeds[1]]];
    lg.playoffs = { seeds, bracket };
    this.save(lg);
  },

  advanceWeek(lg, week) {
    const res = this.scoreWeek(lg, week);
    if (!res.recorded) {
      // Playoff games decide who advances; they do not touch season records.
      if (!res.playoff) {
        for (const m of res.matchups) {
          const h = lg.teams.find((t) => t.id === m.home);
          const a = lg.teams.find((t) => t.id === m.away);
          if (!h || !a) continue;
          h.pf += m.homePts; h.pa += m.awayPts;
          a.pf += m.awayPts; a.pa += m.homePts;
          if (m.winner === h.id) { h.wins++; a.losses++; }
          else if (m.winner === a.id) { a.wins++; h.losses++; }
          else { h.ties++; a.ties++; }
        }
      }
      res.recorded = true;
      lg.currentWeek = week + 1;

      if (week === REG_WEEKS) {
        this.seedPlayoffs(lg);
      } else if (week === SEMI_WEEK && lg.playoffs) {
        // A tie in a playoff game falls to the higher seed.
        const advance = res.matchups.map((m) =>
          m.winner || (lg.playoffs.seeds.indexOf(m.home) < lg.playoffs.seeds.indexOf(m.away) ? m.home : m.away));
        if (advance.length === 2) lg.playoffs.bracket[FINAL_WEEK] = [[advance[0], advance[1]]];
      } else if (week === FINAL_WEEK && lg.playoffs) {
        const m = res.matchups[0];
        if (m) {
          lg.champion = m.winner
            || (lg.playoffs.seeds.indexOf(m.home) < lg.playoffs.seeds.indexOf(m.away) ? m.home : m.away);
        }
      }
      this.save(lg);
    }
    return res;
  },

  /** Play every remaining week in one go. Returns the weeks that were played. */
  simulateSeason(lg) {
    const played = [];
    let guard = 0;
    while (lg.currentWeek <= LAST_WEEK && guard++ < 40) {
      const wk = lg.currentWeek;
      if (wk > REG_WEEKS && !this.pairsFor(lg, wk).length) { lg.currentWeek++; continue; }
      this.advanceWeek(lg, wk);
      played.push(wk);
    }
    this.save(lg);
    return played;
  },
};

/**
 * A 14-week regular season. A round robin is shorter than that for small
 * leagues, so the rotation repeats — which is what real leagues do too.
 */
function buildSeasonSchedule(teamIds) {
  const rr = buildSchedule(teamIds);
  if (!rr.length) return [];
  const out = [];
  for (let w = 0; w < REG_WEEKS; w++) out.push(rr[w % rr.length]);
  return out;
}

/** Circle-method round robin, mirroring the Worker's buildSchedule. */
function buildSchedule(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 === 1) ids.push(null);
  const n = ids.length;
  const rounds = [];
  for (let r = 0; r < (n - 1) * 2; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i], b = ids[n - 1 - i];
      if (a && b) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

/* -------------------------------------------------------------- cloud calls */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(S.api.replace(/\/$/, '') + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(S.token ? { authorization: 'Bearer ' + S.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'Bad response from server.' }));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function connectWs(leagueId) {
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  const base = S.api.replace(/^http/, 'ws').replace(/\/$/, '');
  const url = `${base}/api/ws/${leagueId}?userId=${encodeURIComponent(S.user?.id || '')}`;
  const ws = new WebSocket(url);
  S.ws = ws;

  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'state') {
      const prevPicks = S.league?.draft?.picks?.length || 0;
      S.league = msg.state;
      S.myTeamId = S.league.teams.find((t) => t.userId === S.user?.id)?.id || null;
      if (msg.event?.kind === 'pick' && msg.state.draft.picks.length > prevPicks) {
        announcePick(msg.state.draft.picks[msg.state.draft.picks.length - 1], msg.event);
      }
      render();
    } else if (msg.type === 'chat') {
      S.league?.chat.push(msg.message);
      if (S.view === 'draft') renderChat();
    }
  };
  ws.onclose = () => { if (isCloud()) setTimeout(() => S.league && connectWs(leagueId), 2500); };
  setInterval(() => { try { ws.readyState === 1 && ws.send('{"type":"ping"}'); } catch {} }, 25000);
}

/* ------------------------------------------------------------- action layer
   One surface, two backends. Views never care which mode is active.        */

const Act = {
  async pick(playerId) {
    if (isCloud()) {
      await api(`/api/leagues/${S.league.id}/pick`, { method: 'POST', body: { playerId } });
      return;
    }
    const lg = S.league;
    const r = Local.pick(lg, S.myTeamId, playerId);
    if (r.error) return toast(r.error, 'bad');
    announcePick(lg.draft.picks[lg.draft.picks.length - 1]);
    render();
    scheduleBots();
  },

  async setLineup(slots) {
    if (isCloud()) {
      await api(`/api/leagues/${S.league.id}/lineup`, { method: 'POST', body: { week: S.week, slots } });
      return;
    }
    const lg = S.league;
    if (!lg.lineups[S.week]) lg.lineups[S.week] = {};
    lg.lineups[S.week][S.myTeamId] = slots;
    const t = myTeam(); if (t) t.slots = slots;
    Local.save(lg);
    render();
  },

  async chat(text) {
    if (isCloud()) return api(`/api/leagues/${S.league.id}/chat`, { method: 'POST', body: { text } });
    S.league.chat.push({
      id: String(Math.random()), teamId: S.myTeamId, name: myTeam()?.name || 'You',
      color: myTeam()?.color, text, at: Date.now(),
    });
    Local.save(S.league);
    renderChat();
  },

  async startDraft() {
    if (isCloud()) return api(`/api/leagues/${S.league.id}/start-draft`, { method: 'POST', body: {} });
    Local.startDraft(S.league);
    render();
    scheduleBots();
  },

  async advanceWeek() {
    if (isCloud()) {
      const r = await api(`/api/leagues/${S.league.id}/advance-week`, { method: 'POST', body: { week: S.week } });
      if (r.played === false) {
        toast(r.reason || 'No box scores published for that week yet.', 'bad');
        return r;
      }
      await Act.refresh();
      celebrateWeek(S.week);
      return r;
    }
    const played = S.week;
    Local.advanceWeek(S.league, played);
    S.week = Math.min(S.league.currentWeek, LAST_WEEK);
    render();
    if (S.league.champion && played === FINAL_WEEK) celebrateChampion();
    else celebrateWeek(played);
  },

  async refresh() {
    if (!isCloud()) return;
    const { league } = await api(`/api/leagues/${S.league.id}/get`);
    S.league = league;
    S.myTeamId = league.teams.find((t) => t.userId === S.user?.id)?.id || null;
    render();
  },
};

/* ------------------------------------------------------------ draft engine */

let botTimer = null;
let clockTimer = null;

/** In local mode the bots pick on a timer so the draft feels live. */
function scheduleBots() {
  clearTimeout(botTimer);
  const lg = S.league;
  if (!lg || lg.local !== true) return;
  if (lg.draft.status !== 'live' || !lg.draft.current) return;

  const onClock = lg.teams.find((t) => t.id === lg.draft.current.teamId);
  if (!onClock || !onClock.bot) return;

  const delay = 700 + Math.random() * 1400;
  botTimer = setTimeout(() => {
    const r = Local.pick(lg, onClock.id, null);
    if (r.ok) {
      announcePick(lg.draft.picks[lg.draft.picks.length - 1]);
      render();
      scheduleBots();
    }
  }, delay);
}

/** Human auto-pick when the clock runs out (local mode only; cloud uses DO alarms). */
function tickClock() {
  const lg = S.league;
  if (!lg || lg.draft.status !== 'live' || !lg.draft.current) return;

  const left = lg.draft.current.deadline - Date.now();
  const ring = $('#clock-ring');
  if (ring) updateClockRing(Math.max(0, left));

  if (left <= 0 && lg.local === true) {
    const onClock = lg.teams.find((t) => t.id === lg.draft.current.teamId);
    if (onClock && !onClock.bot) {
      const q = (lg.draft.queues[onClock.id] || [])[0];
      const r = Local.pick(lg, onClock.id, q || null);
      if (r.ok) {
        toast('Clock expired — auto-picked ' + player(r.playerId).n, 'bad');
        announcePick(lg.draft.picks[lg.draft.picks.length - 1]);
        render(); scheduleBots();
      }
    }
  }
}

function updateClockRing(ms) {
  const lg = S.league;
  const total = lg.settings.pickSeconds * 1000;
  const frac = Math.max(0, Math.min(1, ms / total));
  const circ = 2 * Math.PI * 26;
  const arc = $('#clock-arc');
  const val = $('#clock-val');
  if (arc) {
    arc.style.strokeDashoffset = String(circ * (1 - frac));
    arc.style.stroke = frac < 0.25 ? 'var(--hot)' : frac < 0.5 ? 'var(--gold)' : 'var(--mint)';
  }
  if (val) val.textContent = Math.ceil(ms / 1000);
  const bar = $('.clock-bar');
  if (bar) bar.classList.toggle('urgent', frac < 0.25);
}

function announcePick(pick, evt) {
  if (!pick) return;
  const p = player(pick.playerId);
  const team = S.league.teams.find((t) => t.id === pick.teamId);
  S.ticker.unshift({
    text: `<b>${esc(team?.name || 'Team')}</b> selects <b>${esc(p.n)}</b> <span class="dim">${p.p} · ${p.t}</span>`,
    color: team?.color || 'var(--mint)',
    id: pick.overall,
  });
  S.ticker = S.ticker.slice(0, 40);

  if (pick.teamId === S.myTeamId) {
    window.__pickBurst?.(team?.color || '#00e5a0');
    toast(`You drafted ${p.n}`, 'good');
  }
}

/* --------------------------------------------------------------- ceremony */

let ceremony = null;

function celebrateWeek(week) {
  const lg = S.league;
  const res = lg.results[week];
  if (!res || !res.matchups?.length) return;

  // Highest-scoring team of the week gets the trophy moment.
  let best = null;
  for (const [teamId, sc] of Object.entries(res.scores)) {
    if (!best || sc.total > best.total) best = { teamId, total: sc.total };
  }
  if (!best) return;
  const team = lg.teams.find((t) => t.id === best.teamId);
  if (!team) return;

  const mine = best.teamId === S.myTeamId;
  showCeremony({
    kicker: `Week ${week} · Highest Score`,
    name: team.name,
    detail: `${fmt1(best.total)} points${mine ? ' · that\'s you' : ` · managed by ${team.owner}`}`,
  });
}

/** End-of-season trophy for whoever wins the championship game. */
function celebrateChampion() {
  const lg = S.league;
  const team = lg.teams.find((t) => t.id === lg.champion);
  if (!team) return;
  const final = lg.results[FINAL_WEEK];
  const m = final?.matchups?.[0];
  const score = m ? `${fmt1(Math.max(m.homePts, m.awayPts))} – ${fmt1(Math.min(m.homePts, m.awayPts))}` : '';
  showCeremony({
    kicker: `${lg.settings.season} Champion`,
    name: team.name,
    detail: `${team.wins}-${team.losses} regular season${score ? ` · won the final ${score}` : ''}${
      team.id === S.myTeamId ? " · that's you" : ` · managed by ${team.owner}`}`,
  });
}

function showCeremony({ kicker, name, detail }) {
  const wrap = $('#ceremony');
  $('#cer-kicker').textContent = kicker;
  $('#cer-name').textContent = name;
  $('#cer-score').textContent = detail;
  wrap.classList.add('on');

  ceremony = ceremony || new window.__Ceremony__($('#cer-canvas'));
  ceremony.start();

  const close = () => {
    wrap.classList.remove('on');
    ceremony.stop();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('#cer-close').onclick = close;
}

/* =============================================================== rendering */

function render() {
  if (!S.league) { renderGate(); return; }
  $('#gate').style.display = 'none';
  $('#app').style.display = 'flex';
  renderTopbar();
  renderNav();

  const main = $('#main');
  main.innerHTML = '';
  const page = el('div', { class: 'page' });
  main.appendChild(page);

  switch (S.view) {
    case 'draft': renderDraft(page); break;
    case 'team': renderTeam(page); break;
    case 'matchup': renderMatchup(page); break;
    case 'standings': renderStandings(page); break;
    case 'league': renderLeagueInfo(page); break;
  }

  const cup = $('#replay-cup');
  if (cup) cup.onclick = () => celebrateChampion();
}

function renderTopbar() {
  const lg = S.league;
  const live = lg.draft.status === 'live';
  $('#topbar-league').innerHTML = `
    <div style="font-weight:800;letter-spacing:-.02em">${esc(lg.name)}</div>
    <div class="tiny dim">${esc(SCORING_LABELS[lg.settings.scoring] || lg.settings.scoring)} · ${lg.teams.length} teams</div>`;
  $('#topbar-status').innerHTML = `
    ${live ? '<span class="badge live"><span class="live-dot"></span>Draft live</span>' : ''}
    ${isCloud()
      ? `<span class="badge cloud">Shared · ${esc(lg.code)}</span>`
      : '<span class="badge local">Local league</span>'}`;
}

function renderNav() {
  const items = [
    ['draft', 'Draft', 'M4 6h16M4 12h16M4 18h10'],
    ['team', 'Team', 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0'],
    ['matchup', 'Matchup', 'M8 4v16M16 4v16M3 12h18'],
    ['standings', 'Standings', 'M4 20V10M10 20V4M16 20v-8M22 20h-20'],
    ['league', 'League', 'M12 3l8 4v6c0 4.5-3.4 7.5-8 8-4.6-.5-8-3.5-8-8V7z'],
  ];
  const html = items.map(([id, label, d]) => `
    <button class="rail-btn ${S.view === id ? 'on' : ''}" data-view="${id}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>
      <span>${label}</span>
    </button>`).join('');

  for (const nav of [$('#rail'), $('#mobile-tabs')]) {
    nav.innerHTML = html;
    $$('.rail-btn', nav).forEach((b) => {
      b.onclick = () => { S.view = b.dataset.view; render(); };
    });
  }
}

/* ---------------------------------------------------------------- gate view */

function renderGate() {
  $('#app').style.display = 'none';
  const gate = $('#gate');
  gate.style.display = 'grid';

  const saved = Local.load();
  gate.innerHTML = `
    <canvas id="gate-canvas"></canvas>
    <div class="gate-inner">
      <div class="gate-logo"><div class="brand-mark">🏈</div></div>
      <h1>Draft. Score.<br>Take the trophy.</h1>
      <p class="lede">A full fantasy football league — live snake draft, real NFL production data,
        weekly matchups, and a trophy ceremony for whoever hangs the highest score.</p>

      <div class="card gate-card">
        <div class="tabs">
          <button data-tab="solo" class="on">Play now</button>
          <button data-tab="cloud">Shared league</button>
        </div>

        <div id="tab-solo" class="stack">
          ${saved ? `
            <button class="btn btn-primary btn-lg" id="resume">Resume ${esc(saved.name)}</button>
            <div class="divider">or start over</div>` : ''}
          <div class="field"><label>League name</label><input type="text" id="lg-name" value="Sunday Showdown" maxlength="40"></div>
          <div class="field"><label>Your team</label><input type="text" id="lg-team" value="My Team" maxlength="40"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px">
            <div class="field"><label>Teams</label>
              <select id="lg-count">${[4, 6, 8, 10, 12].map((n) => `<option ${n === 10 ? 'selected' : ''}>${n}</option>`).join('')}</select>
            </div>
            <div class="field"><label>Scoring</label>
              <select id="lg-scoring">${Object.entries(SCORING_LABELS).map(([k, v]) =>
                `<option value="${k}" ${k === 'half_ppr' ? 'selected' : ''}>${v}</option>`).join('')}</select>
            </div>
          </div>
          ${SEASON ? `<div class="field"><label>Weekly results</label>
            <select id="lg-data">
              <option value="replay" selected>Replay the real ${SEASON.season} season</option>
              <option value="sim">Simulate from season averages</option>
            </select></div>` : ''}
          <button class="btn btn-primary btn-lg" id="create-local">Create league &amp; draft</button>
          <p class="tiny dim" style="margin:0;line-height:1.5">Plays entirely in your browser against CPU managers,
            using real ${POOL.basis} NFL production for ${POOL.players.length} players.
            ${SEASON ? `Replay mode scores every week from the actual ${SEASON.season} box scores — real byes, real injuries, real blow-ups.` : ''}
            Nothing leaves this device.</p>
        </div>

        <div id="tab-cloud" class="stack" style="display:none">
          <div class="field"><label>Worker URL</label>
            <input type="text" id="api-url" placeholder="https://ff-league.you.workers.dev" value="${esc(S.api)}">
          </div>
          <div id="cloud-auth" class="stack"></div>
          <p class="tiny dim" style="margin:0;line-height:1.5">Deploy the included Cloudflare Worker, paste its URL here,
            and your league syncs live across everyone's devices with real weekly NFL scoring.</p>
        </div>
      </div>
    </div>`;

  // Canvas exists only now that the gate markup is in the DOM.
  window.__hero__?.start();

  $$('.tabs button', gate).forEach((b) => {
    b.onclick = () => {
      $$('.tabs button', gate).forEach((x) => x.classList.toggle('on', x === b));
      $('#tab-solo').style.display = b.dataset.tab === 'solo' ? 'flex' : 'none';
      $('#tab-cloud').style.display = b.dataset.tab === 'cloud' ? 'flex' : 'none';
    };
  });

  if (saved) {
    $('#resume').onclick = () => {
      S.league = saved; S.mode = 'local'; S.myTeamId = 'T0';
      S.week = saved.currentWeek || 1;
      S.view = saved.draft.status === 'done' ? 'team' : 'draft';
      render(); scheduleBots();
    };
  }

  $('#create-local').onclick = () => {
    const lg = Local.create({
      name: $('#lg-name').value.trim() || 'My League',
      teamName: $('#lg-team').value.trim() || 'My Team',
      teamCount: Number($('#lg-count').value),
      scoring: $('#lg-scoring').value,
      dataMode: $('#lg-data') ? $('#lg-data').value : 'replay',
    });
    S.league = lg; S.mode = 'local'; S.myTeamId = 'T0'; S.view = 'draft'; S.week = 1;
    render();
  };

  renderCloudAuth();
}

function renderCloudAuth() {
  const box = $('#cloud-auth');
  if (!box) return;

  if (S.user && S.token) {
    box.innerHTML = `
      <div class="ok-msg">Signed in as ${esc(S.user.displayName || S.user.email)}</div>
      <div class="field"><label>Create a league</label><input type="text" id="c-name" placeholder="League name" maxlength="40"></div>
      <button class="btn btn-primary" id="c-create">Create league</button>
      <div class="divider">or join</div>
      <div class="field"><label>Invite code</label><input type="text" id="c-code" placeholder="ABC123" maxlength="6" style="text-transform:uppercase"></div>
      <button class="btn" id="c-join">Join league</button>
      <div id="c-leagues" class="stack"></div>
      <button class="btn btn-ghost btn-sm" id="c-out">Sign out</button>`;

    $('#c-create').onclick = async () => {
      try {
        S.api = $('#api-url').value.trim(); localStorage.setItem('gi.api', S.api);
        const r = await api('/api/leagues/create', {
          method: 'POST',
          body: { name: $('#c-name').value.trim() || 'My League', displayName: S.user.displayName },
        });
        enterCloudLeague(r.league);
      } catch (e) { toast(e.message, 'bad'); }
    };
    $('#c-join').onclick = async () => {
      try {
        S.api = $('#api-url').value.trim(); localStorage.setItem('gi.api', S.api);
        const r = await api('/api/leagues/join', {
          method: 'POST',
          body: { code: $('#c-code').value.trim().toUpperCase(), displayName: S.user.displayName },
        });
        enterCloudLeague(r.league);
      } catch (e) { toast(e.message, 'bad'); }
    };
    $('#c-out').onclick = () => {
      S.user = null; S.token = '';
      localStorage.removeItem('gi.user'); localStorage.removeItem('gi.token');
      renderCloudAuth();
    };

    loadMyLeagues();
    return;
  }

  box.innerHTML = `
    <div class="tabs" style="margin:0 0 4px">
      <button data-auth="login" class="on">Sign in</button>
      <button data-auth="register">Register</button>
    </div>
    <div class="field"><label>Email</label><input type="email" id="a-email" placeholder="you@example.com"></div>
    <div class="field" id="a-name-field" style="display:none"><label>Display name</label><input type="text" id="a-name" placeholder="Your name"></div>
    <div class="field"><label>Password</label><input type="password" id="a-pass" placeholder="At least 8 characters"></div>
    <button class="btn btn-primary" id="a-go">Sign in</button>`;

  let mode = 'login';
  $$('[data-auth]', box).forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.auth;
      $$('[data-auth]', box).forEach((x) => x.classList.toggle('on', x === b));
      $('#a-name-field').style.display = mode === 'register' ? 'flex' : 'none';
      $('#a-go').textContent = mode === 'register' ? 'Create account' : 'Sign in';
    };
  });

  $('#a-go').onclick = async () => {
    S.api = $('#api-url').value.trim();
    if (!S.api) return toast('Enter your Worker URL first.', 'bad');
    localStorage.setItem('gi.api', S.api);
    try {
      const r = await api(`/api/auth/${mode}`, {
        method: 'POST',
        body: {
          email: $('#a-email').value.trim(),
          password: $('#a-pass').value,
          displayName: $('#a-name')?.value?.trim(),
        },
      });
      S.token = r.token; S.user = r.user;
      localStorage.setItem('gi.token', r.token);
      localStorage.setItem('gi.user', JSON.stringify(r.user));
      renderCloudAuth();
    } catch (e) { toast(e.message, 'bad'); }
  };
}

async function loadMyLeagues() {
  try {
    const { leagues } = await api('/api/me');
    if (!leagues?.length) return;
    const box = $('#c-leagues');
    box.innerHTML = '<div class="divider">your leagues</div>' + leagues.map((l) =>
      `<button class="btn" data-lg="${esc(l.id)}" style="justify-content:space-between;width:100%">
         <span>${esc(l.name || 'League')}</span><span class="tiny dim">${esc(l.code || '')}</span></button>`).join('');
    $$('[data-lg]', box).forEach((b) => {
      b.onclick = async () => {
        try {
          const { league } = await api(`/api/leagues/${b.dataset.lg}/get`);
          enterCloudLeague(league);
        } catch (e) { toast(e.message, 'bad'); }
      };
    });
  } catch { /* not signed in or worker unreachable — leave the panel as-is */ }
}

function enterCloudLeague(league) {
  S.league = league;
  S.mode = 'cloud';
  S.myTeamId = league.teams.find((t) => t.userId === S.user?.id)?.id || null;
  S.week = league.currentWeek || 1;
  S.view = league.draft.status === 'done' ? 'team' : 'draft';
  window.__hero__?.stop();
  connectWs(league.id);
  render();
}

/* --------------------------------------------------------------- draft view */

function renderDraft(page) {
  const lg = S.league;

  if (lg.draft.status === 'pre') { renderPreDraft(page); return; }

  page.appendChild(el('div', { class: 'draft-layout' }, `
    <div style="min-width:0;display:flex;flex-direction:column">
      <div id="clock-slot"></div>
      <div class="board-wrap" style="max-height:34vh;margin-bottom:14px"><div id="board"></div></div>
      <div class="card" style="padding:14px;flex:1;min-height:0;display:flex;flex-direction:column">
        <div class="pool-toolbar">
          <div class="search-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input type="text" id="q" placeholder="Search players…" value="${esc(S.filter.q)}">
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap" id="pos-chips"></div>
          <select id="sort" style="width:auto">
            <option value="v">Sort: Value</option>
            <option value="ppg">Sort: Pts/game</option>
            <option value="pts">Sort: ${POOL.basis} total</option>
            <option value="name">Sort: Name</option>
          </select>
        </div>
        <div class="player-list" id="pool" style="overflow-y:auto;flex:1"></div>
      </div>
    </div>
    <div class="side-panel">
      <div class="card panel" id="my-roster-panel"></div>
      <div class="card panel" style="flex:1;min-height:150px">
        <h3>Draft feed</h3>
        <div class="ticker" id="ticker" style="max-height:190px"></div>
      </div>
      <div class="card panel" style="min-height:180px">
        <h3>Trash talk</h3>
        <div class="chat-log" id="chat"></div>
        <div style="display:flex;gap:6px">
          <input type="text" id="chat-in" placeholder="Say something…" maxlength="200">
          <button class="btn btn-sm" id="chat-send">Send</button>
        </div>
      </div>
    </div>`));

  renderClock();
  renderBoard();
  renderPool();
  renderMyRoster();
  renderTicker();
  renderChat();

  $('#q').oninput = (e) => { S.filter.q = e.target.value; renderPool(); };
  $('#sort').value = S.filter.sort;
  $('#sort').onchange = (e) => { S.filter.sort = e.target.value; renderPool(); };

  const chips = $('#pos-chips');
  chips.innerHTML = ['ALL', ...POSITIONS].map((p) =>
    `<button class="chip ${S.filter.pos === p ? 'on' : ''}" data-pos="${p}">${p}</button>`).join('');
  $$('[data-pos]', chips).forEach((b) => {
    b.onclick = () => { S.filter.pos = b.dataset.pos; renderDraft($('.page')); };
  });

  const send = () => {
    const v = $('#chat-in').value.trim();
    if (!v) return;
    $('#chat-in').value = '';
    Act.chat(v).catch((e) => toast(e.message, 'bad'));
  };
  $('#chat-send').onclick = send;
  $('#chat-in').onkeydown = (e) => { if (e.key === 'Enter') send(); };
}

function renderPreDraft(page) {
  const lg = S.league;
  const rounds = expandRoster(lg.settings.roster).length;
  page.innerHTML = `
    <div class="page-head"><h1>Draft lobby</h1>
      <div class="sub">${lg.teams.length} of ${lg.settings.teamCount} managers · ${rounds} rounds · ${lg.settings.pickSeconds}s per pick</div>
    </div>
    <div class="card" style="padding:20px;margin-bottom:14px">
      ${isCloud() ? `<p class="muted" style="margin-top:0">Share this invite code so your league can join:</p>
        <div style="font-family:ui-monospace,monospace;font-size:34px;font-weight:800;letter-spacing:.2em;color:var(--mint)">${esc(lg.code)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        ${isCommish() ? '<button class="btn btn-primary btn-lg" id="start">Start the draft</button>' : '<span class="muted">Waiting for the commissioner to start…</span>'}
      </div>
    </div>
    <div class="league-grid">
      ${lg.teams.map((t) => `
        <div class="card" style="padding:14px;display:flex;align-items:center;gap:11px">
          <div class="swatch" style="background:${esc(t.color)};height:34px"></div>
          <div style="min-width:0">
            <div style="font-weight:700">${esc(t.name)}</div>
            <div class="tiny dim">${esc(t.owner)}${t.bot ? ' · CPU' : ''}</div>
          </div>
        </div>`).join('')}
    </div>`;
  const b = $('#start');
  if (b) b.onclick = () => Act.startDraft().catch((e) => toast(e.message, 'bad'));
}

function renderClock() {
  const lg = S.league;
  const cur = lg.draft.current;
  const slot = $('#clock-slot');
  if (!slot) return;

  if (!cur || lg.draft.status === 'done') {
    slot.innerHTML = `<div class="clock-bar" style="--team-color:var(--gold)">
      <div style="flex:1">
        <div class="onclock-label">Draft complete</div>
        <div class="onclock-team">Set your lineup</div>
      </div>
      <button class="btn btn-primary" id="to-team">Go to my team →</button>
    </div>`;
    $('#to-team').onclick = () => { S.view = 'team'; render(); };
    return;
  }

  const team = lg.teams.find((t) => t.id === cur.teamId);
  const mine = cur.teamId === S.myTeamId;
  const circ = 2 * Math.PI * 26;

  slot.innerHTML = `
    <div class="clock-bar" style="--team-color:${esc(team?.color || '#00e5a0')}">
      <div class="clock-ring" id="clock-ring">
        <svg width="60" height="60">
          <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="5"/>
          <circle id="clock-arc" cx="30" cy="30" r="26" fill="none" stroke="var(--mint)" stroke-width="5"
            stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="0" style="transition:stroke-dashoffset .3s linear"/>
        </svg>
        <div class="val num" id="clock-val">–</div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="onclock-label">${mine ? "You're on the clock" : 'On the clock'}</div>
        <div class="onclock-team">${esc(team?.name || '')}</div>
      </div>
      <div style="text-align:right">
        <div class="onclock-label">Round ${cur.round} · Pick ${cur.pickInRound}</div>
        <div class="tiny dim">${cur.overall} of ${lg.draft.order.length * lg.settings.rounds} overall</div>
      </div>
      ${isCommish() && lg.draft.status === 'live' ? '' : ''}
    </div>`;
  updateClockRing(Math.max(0, cur.deadline - Date.now()));
}

function renderBoard() {
  const lg = S.league;
  const box = $('#board');
  if (!box) return;

  const order = lg.draft.order;
  const rounds = lg.settings.rounds;
  const picks = new Map(lg.draft.picks.map((p) => [p.overall, p]));
  const latest = lg.draft.picks.length;

  let html = '<table class="board"><thead><tr><th></th>';
  for (const tid of order) {
    const t = lg.teams.find((x) => x.id === tid);
    html += `<th title="${esc(t?.name)}">${esc(t?.name || '')}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let r = 1; r <= rounds; r++) {
    html += `<tr><td class="rd">R${r}</td>`;
    for (let i = 0; i < order.length; i++) {
      // Snake: even rounds fill right-to-left.
      const posInRound = r % 2 === 1 ? i : order.length - 1 - i;
      const overall = (r - 1) * order.length + posInRound + 1;
      const pick = picks.get(overall);
      const team = lg.teams.find((x) => x.id === order[i]);
      const isCur = lg.draft.current?.overall === overall;

      if (pick) {
        const p = player(pick.playerId);
        html += `<td><div class="cell filled ${overall === latest ? 'just' : ''}"
          style="--c:${hexA(team?.color || '#888', .18)}">
          <div class="nm">${esc(p.n)}</div>
          <div class="mt"><span class="pos ${p.p}" style="min-width:0;padding:1px 4px;font-size:9px">${p.p}</span>${esc(p.t)}</div>
        </div></td>`;
      } else {
        html += `<td><div class="cell ${isCur ? 'oncl' : ''}">${isCur
          ? '<div class="mt" style="color:var(--mint);font-weight:700">On the clock</div>'
          : `<div class="mt dim">${overall}</div>`}</div></td>`;
      }
    }
    html += '</tr>';
  }
  box.innerHTML = html + '</tbody></table>';

  // Keep the active round in view.
  const active = box.querySelector('.cell.oncl');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderPool() {
  const lg = S.league;
  const box = $('#pool');
  if (!box) return;

  const taken = new Set(lg.draft.picks.map((p) => p.playerId));
  const q = S.filter.q.toLowerCase().trim();
  const mine = myTeam();
  const onClock = lg.draft.current?.teamId === S.myTeamId && lg.draft.status === 'live';

  let list = POOL.players.filter((p) => {
    if (S.filter.pos !== 'ALL' && p.p !== S.filter.pos) return false;
    if (q && !p.n.toLowerCase().includes(q) && !p.t.toLowerCase().includes(q)) return false;
    return true;
  });

  const sort = S.filter.sort;
  list.sort((a, b) => {
    if (sort === 'name') return a.n.localeCompare(b.n);
    return (b[sort] || 0) - (a[sort] || 0);
  });
  // Drafted players sink to the bottom.
  list = [...list.filter((p) => !taken.has(p.id)), ...list.filter((p) => taken.has(p.id))].slice(0, 220);

  box.innerHTML = list.map((p) => {
    const gone = taken.has(p.id);
    const by = gone ? lg.draft.picks.find((x) => x.playerId === p.id) : null;
    const byTeam = by ? lg.teams.find((t) => t.id === by.teamId) : null;
    return `
      <div class="prow ${gone ? 'gone' : ''}" data-id="${esc(p.id)}">
        <div class="rank num">${p.r || ''}</div>
        ${p.s
          ? `<img class="avatar" src="${esc(p.s)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar',textContent:'${esc(initials(p.n))}'}))">`
          : `<div class="avatar">${esc(initials(p.n))}</div>`}
        <div style="min-width:0">
          <div class="nm">${esc(p.n)}</div>
          <div class="mt"><span class="pos ${p.p}">${p.p}</span><span>${esc(p.t)}</span>
            ${gone ? `<span class="dim">· ${esc(byTeam?.name || 'drafted')}</span>` : ''}</div>
        </div>
        <div class="val num"><b>${fmt1(p.ppg)}</b><span>pts/gm</span></div>
        <div class="val num" style="min-width:52px"><b style="color:${p.v > 0 ? 'var(--mint)' : 'var(--dim)'}">${p.v > 0 ? '+' : ''}${fmt1(p.v)}</b><span>value</span></div>
      </div>`;
  }).join('') || '<div class="muted" style="padding:20px;text-align:center">No players match.</div>';

  $$('.prow', box).forEach((row) => {
    row.onclick = () => {
      const id = row.dataset.id;
      if (taken.has(id)) return toast('Already drafted.', 'bad');
      if (!onClock) {
        // Not our turn — queue the player instead.
        const q = lg.draft.queues[S.myTeamId] || (lg.draft.queues[S.myTeamId] = []);
        if (q.includes(id)) { q.splice(q.indexOf(id), 1); toast('Removed from queue'); }
        else { q.push(id); toast(`Queued ${player(id).n}`, 'good'); }
        if (!isCloud()) Local.save(lg);
        else api(`/api/leagues/${lg.id}/queue`, { method: 'POST', body: { playerIds: q } }).catch(() => {});
        renderMyRoster();
        return;
      }
      confirmPick(id);
    };
  });
}

function confirmPick(id) {
  const p = player(id);
  const back = el('div', { class: 'modal-back' });
  back.innerHTML = `
    <div class="modal">
      <h2>Draft ${esc(p.n)}?</h2>
      <div class="sub"><span class="pos ${p.p}">${p.p}</span> ${esc(p.t)} ·
        ${fmt1(p.ppg)} pts/game in ${POOL.basis} · value ${p.v > 0 ? '+' : ''}${fmt1(p.v)}</div>
      <div class="modal-actions">
        <button class="btn" data-x>Cancel</button>
        <button class="btn btn-primary" data-ok>Draft him</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };
  $('[data-x]', back).onclick = close;
  $('[data-ok]', back).onclick = () => { close(); Act.pick(id).catch((e) => toast(e.message, 'bad')); };
}

function renderMyRoster() {
  const box = $('#my-roster-panel');
  if (!box) return;
  const lg = S.league;
  const team = myTeam();
  if (!team) { box.innerHTML = '<h3>My team</h3><div class="muted tiny">You are spectating this league.</div>'; return; }

  const slots = expandRoster(lg.settings.roster);
  const byPos = {};
  for (const id of team.roster) { const p = player(id); (byPos[p.p] = byPos[p.p] || []).push(p); }

  const queue = lg.draft.queues[team.id] || [];

  box.innerHTML = `
    <h3>My roster · ${team.roster.length}/${slots.length}</h3>
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px">
      ${POSITIONS.map((pos) => {
        const n = (byPos[pos] || []).length;
        return `<span class="pos ${pos}" style="opacity:${n ? 1 : .35}">${pos} ${n}</span>`;
      }).join('')}
    </div>
    <div style="max-height:180px;overflow-y:auto">
      ${team.roster.length
        ? team.roster.map((id) => {
            const p = player(id);
            return `<div class="slot-row"><div class="slot-tag">${p.p}</div>
              <div style="min-width:0"><div class="nm">${esc(p.n)}</div><div class="sub">${esc(p.t)}</div></div>
              <div class="num tiny dim">${fmt1(p.ppg)}</div></div>`;
          }).join('')
        : '<div class="muted tiny">No picks yet. Click a player to queue him.</div>'}
    </div>
    ${queue.length ? `<h3 style="margin-top:14px">Queue · ${queue.length}</h3>
      <div style="max-height:120px;overflow-y:auto">${queue.map((id, i) => {
        const p = player(id);
        return `<div class="slot-row"><div class="slot-tag">${i + 1}</div>
          <div style="min-width:0"><div class="nm">${esc(p.n)}</div><div class="sub">${p.p} · ${esc(p.t)}</div></div>
          <button class="btn btn-ghost btn-sm" data-unq="${esc(id)}">✕</button></div>`;
      }).join('')}</div>` : ''}`;

  $$('[data-unq]', box).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const q = lg.draft.queues[team.id];
      q.splice(q.indexOf(b.dataset.unq), 1);
      if (!isCloud()) Local.save(lg);
      renderMyRoster();
    };
  });
}

function renderTicker() {
  const box = $('#ticker');
  if (!box) return;
  box.innerHTML = S.ticker.length
    ? S.ticker.map((t) => `<div class="tick" style="--c:${esc(t.color)}">${t.text}</div>`).join('')
    : '<div class="muted tiny">Picks will appear here.</div>';
}

function renderChat() {
  const box = $('#chat');
  if (!box) return;
  const msgs = S.league.chat || [];
  box.innerHTML = msgs.length
    ? msgs.slice(-40).map((m) => `<div class="msg">
        <span class="who" style="color:${esc(m.color || 'var(--mint)')}">${esc(m.name)}</span>
        <span class="muted"> ${esc(m.text)}</span></div>`).join('')
    : '<div class="muted tiny">Say something…</div>';
  box.scrollTop = box.scrollHeight;
}

/* ---------------------------------------------------------------- team view */

function renderTeam(page) {
  const lg = S.league;
  const team = myTeam();
  if (!team) { page.innerHTML = '<div class="muted">You are not managing a team in this league.</div>'; return; }
  if (lg.draft.status !== 'done') {
    page.innerHTML = '<div class="page-head"><h1>My team</h1></div><div class="card" style="padding:20px" class="muted">Your roster appears once the draft finishes.</div>';
    return;
  }

  const slots = expandRoster(lg.settings.roster);
  const lineup = (lg.lineups[S.week] && lg.lineups[S.week][team.id]) || team.slots || {};
  // Bench = anyone not occupying a *starting* slot.
  const starterIds = new Set(slots.filter((s) => s.starter).map((s) => s.id));
  const assigned = new Set(
    Object.entries(lineup).filter(([slotId, pid]) => pid && starterIds.has(slotId)).map(([, pid]) => pid),
  );
  const bench = team.roster.filter((id) => !assigned.has(id));
  const res = lg.results[S.week];

  const ptsFor = (id) => {
    const d = res?.scores?.[team.id]?.detail?.find((x) => x.playerId === id);
    return d ? d.points : null;
  };

  page.innerHTML = `
    <div class="page-head">
      <h1>${esc(team.name)}</h1>
      <div class="sub">${team.wins}-${team.losses}${team.ties ? '-' + team.ties : ''} · ${fmt1(team.pf)} PF</div>
      <div style="flex:1"></div>
      ${weekPicker()}
    </div>
    <div class="roster-grid">
      <div class="card" style="padding:16px">
        <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Starters</h3>
        <div id="starters"></div>
      </div>
      <div class="card" style="padding:16px">
        <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Bench</h3>
        <div id="bench"></div>
        <p class="tiny dim" style="margin:14px 0 0">Drag a player onto a starting slot to swap him in.</p>
      </div>
    </div>`;

  const rowHtml = (slotId, kind, pid) => {
    const p = pid ? player(pid) : null;
    const pts = pid ? ptsFor(pid) : null;
    return `<div class="lineup-row" data-slot="${esc(slotId)}" data-pid="${esc(pid || '')}" ${pid ? 'draggable="true"' : ''}>
      <div class="slot-tag">${kind === 'BENCH' ? 'BE' : kind}</div>
      ${p ? (p.s
        ? `<img class="avatar" style="width:34px;height:34px" src="${esc(p.s)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar',style:'width:34px;height:34px',textContent:'${esc(initials(p.n))}'}))">`
        : `<div class="avatar" style="width:34px;height:34px">${esc(initials(p.n))}</div>`)
        : '<div class="avatar" style="width:34px;height:34px;opacity:.3"></div>'}
      <div style="min-width:0">
        <div class="nm" style="font-weight:700;font-size:13px">${p ? esc(p.n) : '<span class="dim">Empty</span>'}</div>
        <div class="tiny dim">${p ? `${p.p} · ${esc(p.t)} · ${fmt1(p.ppg)} avg` : ''}</div>
      </div>
      <div class="pts num" style="color:${pts != null ? 'var(--mint)' : 'var(--dim)'}">${pts != null ? fmt1(pts) : '–'}</div>
    </div>`;
  };

  $('#starters').innerHTML = slots.filter((s) => s.starter)
    .map((s) => rowHtml(s.id, s.kind, lineup[s.id])).join('');
  $('#bench').innerHTML = bench.length
    ? bench.map((id, i) => rowHtml('BENCH' + i, 'BENCH', id)).join('')
    : '<div class="muted tiny">Bench is empty.</div>';

  wireLineupDnd(lineup, slots);
  $('#week-sel').onchange = (e) => { S.week = Number(e.target.value); render(); };
}

/** Shared by drag-drop and tap-to-swap: move `pid` into `targetSlot`. */
function applyMove(pid, targetSlot, targetPid, lineup, slots) {
  const next = { ...lineup };
  const fromSlot = Object.keys(next).find((k) => next[k] === pid);

  if (targetSlot.startsWith('BENCH')) {
    if (!fromSlot) return null;            // bench -> bench is a no-op
    delete next[fromSlot];
  } else {
    const kind = slots.find((s) => s.id === targetSlot)?.kind;
    if (!slotAccepts(kind, player(pid).p)) {
      toast(`A ${player(pid).p} cannot start at ${kind}.`, 'bad');
      return null;
    }
    if (fromSlot) delete next[fromSlot];
    next[targetSlot] = pid;
    // Swap rather than drop the displaced starter.
    if (targetPid && targetPid !== pid && fromSlot) next[fromSlot] = targetPid;
  }
  return next;
}

function wireLineupDnd(lineup, slots) {
  let dragPid = null;
  let selected = null;   // tap-to-swap: works where HTML5 drag does not (touch)

  const clearSel = () => {
    selected = null;
    $$('.lineup-row').forEach((r) => (r.style.outline = ''));
  };

  $$('.lineup-row').forEach((row) => {
    // --- tap / click to select, tap again to place. Touch devices never fire
    // dragstart, so this is the only path that works on a phone.
    row.addEventListener('click', () => {
      const pid = row.dataset.pid || null;
      const slot = row.dataset.slot;

      if (!selected) {
        if (!pid) return;
        selected = { pid, slot };
        row.style.outline = '2px solid var(--mint)';
        toast('Now tap the slot to move him into', '');
        return;
      }
      if (selected.slot === slot) { clearSel(); return; }

      const next = applyMove(selected.pid, slot, pid, lineup, slots);
      clearSel();
      if (next) Act.setLineup(next).catch((err) => toast(err.message, 'bad'));
    });

    row.addEventListener('dragstart', (e) => {
      dragPid = row.dataset.pid;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragPid);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      $$('.lineup-row').forEach((r) => r.classList.remove('drop-ok'));
    });
    row.addEventListener('dragover', (e) => {
      if (!dragPid) return;
      const slotId = row.dataset.slot;
      const kind = slots.find((s) => s.id === slotId)?.kind || 'BENCH';
      if (kind !== 'BENCH' && !slotAccepts(kind, player(dragPid).p)) return;
      e.preventDefault();
      row.classList.add('drop-ok');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-ok'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-ok');
      const targetSlot = row.dataset.slot;
      const targetPid = row.dataset.pid || null;
      if (!dragPid || !targetSlot) return;

      const next = applyMove(dragPid, targetSlot, targetPid, lineup, slots);
      dragPid = null;
      clearSel();
      if (next) Act.setLineup(next).catch((err) => toast(err.message, 'bad'));
    });
  });
}

function weekPicker() {
  const lg = S.league;
  const weeks = isCloud() ? Math.max(lg.schedule?.length || 14, lg.currentWeek) : LAST_WEEK;
  const label = (w) => (w === SEMI_WEEK ? 'Semifinals' : w === FINAL_WEEK ? 'Championship' : `Week ${w}`);
  return `<select id="week-sel" style="width:auto">
    ${Array.from({ length: weeks }, (_, i) => i + 1).map((w) =>
      `<option value="${w}" ${w === S.week ? 'selected' : ''}>${isCloud() ? `Week ${w}` : label(w)}</option>`).join('')}
  </select>`;
}

/* ------------------------------------------------------------- matchup view */

function renderMatchup(page) {
  const lg = S.league;
  if (!lg.schedule) {
    page.innerHTML = '<div class="page-head"><h1>Matchups</h1></div><div class="card" style="padding:20px" class="muted">The schedule is generated when the draft ends.</div>';
    return;
  }

  const res = lg.results[S.week];
  const pairs = isCloud() ? (lg.schedule[S.week - 1] || []) : Local.pairsFor(lg, S.week);
  const roundName = S.week === SEMI_WEEK ? 'Semifinals' : S.week === FINAL_WEEK ? 'Championship' : `Week ${S.week}`;
  const canSim = !isCloud() && lg.currentWeek <= LAST_WEEK;

  page.innerHTML = `
    <div class="page-head">
      <h1>${roundName}</h1>
      <div class="sub">${S.week > REG_WEEKS ? 'Playoffs · ' : ''}${res?.recorded ? 'Final' : 'Not played yet'}${
        lg.settings.dataMode === 'replay' ? ` · real ${lg.settings.season} results` : ''}</div>
      <div style="flex:1"></div>
      ${weekPicker()}
      ${isCommish() ? `<button class="btn ${res?.recorded ? '' : 'btn-primary'}" id="play-week">
        ${res?.recorded ? 'Replay ceremony' : `Play ${S.week > REG_WEEKS ? roundName.toLowerCase() : 'week ' + S.week}`}</button>` : ''}
      ${canSim ? '<button class="btn" id="sim-season">Sim to end of season ⏩</button>' : ''}
    </div>
    ${!pairs.length && S.week > REG_WEEKS
      ? `<div class="card" style="padding:20px" class="muted">The bracket is set after week ${REG_WEEKS}.</div>` : ''}
    <div id="matchups" style="display:flex;flex-direction:column;gap:12px"></div>`;

  $('#week-sel').onchange = (e) => { S.week = Number(e.target.value); render(); };
  const btn = $('#play-week');
  if (btn) {
    btn.onclick = async () => {
      if (res?.recorded) return celebrateWeek(S.week);
      btn.disabled = true;
      try { await Act.advanceWeek(); } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
    };
  }
  const simBtn = $('#sim-season');
  if (simBtn) {
    simBtn.onclick = () => {
      simBtn.disabled = true;
      const played = Local.simulateSeason(S.league);
      S.week = Math.min(S.league.currentWeek, LAST_WEEK);
      render();
      if (!played.length) return toast('Season already complete.', '');
      // The champion gets the trophy; otherwise fall back to the last week.
      if (S.league.champion) celebrateChampion();
      else celebrateWeek(played[played.length - 1]);
    };
  }

  const box = $('#matchups');
  box.innerHTML = pairs.map(([aId, bId]) => {
    const a = lg.teams.find((t) => t.id === aId);
    const b = lg.teams.find((t) => t.id === bId);
    const m = res?.matchups?.find((x) => x.home === aId && x.away === bId);
    const pa = m?.homePts ?? 0, pb = m?.awayPts ?? 0;
    const tot = pa + pb || 1;
    const mine = aId === S.myTeamId || bId === S.myTeamId;

    return `<div class="card" style="padding:16px${mine ? ';border-color:rgba(0,229,160,.32)' : ''}">
      <div class="vs-grid">
        <div style="display:flex;align-items:center;gap:11px">
          <div class="swatch" style="background:${esc(a?.color)};height:38px"></div>
          <div style="min-width:0">
            <div style="font-weight:800;font-size:15px">${esc(a?.name)}</div>
            <div class="tiny dim">${a?.wins}-${a?.losses}</div>
          </div>
          <div style="flex:1"></div>
          <div class="score-big num" style="color:${m && m.winner === aId ? 'var(--mint)' : 'inherit'}">${m ? fmt1(pa) : '–'}</div>
        </div>
        <div style="text-align:center;color:var(--dim);font-weight:800;font-size:12px">VS</div>
        <div style="display:flex;align-items:center;gap:11px">
          <div class="score-big num" style="color:${m && m.winner === bId ? 'var(--mint)' : 'inherit'}">${m ? fmt1(pb) : '–'}</div>
          <div style="flex:1"></div>
          <div style="min-width:0;text-align:right">
            <div style="font-weight:800;font-size:15px">${esc(b?.name)}</div>
            <div class="tiny dim">${b?.wins}-${b?.losses}</div>
          </div>
          <div class="swatch" style="background:${esc(b?.color)};height:38px"></div>
        </div>
      </div>
      ${m ? `<div class="winbar" style="margin-top:12px">
        <i style="width:${(pa / tot) * 100}%;background:${esc(a?.color)}"></i>
        <i style="width:${(pb / tot) * 100}%;background:${esc(b?.color)}"></i>
      </div>
      <details style="margin-top:12px"><summary class="tiny dim" style="cursor:pointer">Player breakdown</summary>
        <div style="margin-top:10px">${breakdown(aId, bId, res)}</div>
      </details>` : ''}
    </div>`;
  }).join('') || '<div class="muted">No games this week.</div>';
}

function breakdown(aId, bId, res) {
  const lg = S.league;
  const slots = expandRoster(lg.settings.roster).filter((s) => s.starter);
  const get = (tid, slotId) => res.scores[tid]?.detail?.find((d) => d.slotId === slotId);

  const nameCell = (d, p) => {
    if (!p) return '<span class="dim">—</span>';
    return `${esc(p.n)}${d && d.bye ? ' <span class="tiny dim">BYE</span>' : ''}`;
  };

  return slots.map((s) => {
    const da = get(aId, s.id), db = get(bId, s.id);
    const pa = da ? player(da.playerId) : null;
    const pb = db ? player(db.playerId) : null;
    return `<div class="mrow">
      <div class="side">
        <span class="p num" style="color:${da && db && da.points > db.points ? 'var(--mint)' : 'var(--muted)'}">${da ? fmt1(da.points) : '–'}</span>
        <span class="nm">${nameCell(da, pa)}</span>
      </div>
      <div class="slot">${s.kind}</div>
      <div class="side right">
        <span class="p num" style="color:${da && db && db.points > da.points ? 'var(--mint)' : 'var(--muted)'}">${db ? fmt1(db.points) : '–'}</span>
        <span class="nm">${nameCell(db, pb)}</span>
      </div>
    </div>`;
  }).join('');
}

/* ----------------------------------------------------------- standings view */

function renderStandings(page) {
  const lg = S.league;
  const teams = [...lg.teams].sort((a, b) => {
    const wa = a.wins + a.ties * 0.5, wb = b.wins + b.ties * 0.5;
    if (wb !== wa) return wb - wa;
    return b.pf - a.pf;
  });

  const playoffCut = isCloud() ? 0 : Math.min(4, lg.teams.length);
  const done = Math.min(lg.currentWeek - 1, REG_WEEKS);

  page.innerHTML = `
    <div class="page-head"><h1>Standings</h1>
      <div class="sub">${done > 0 ? `Through ${done === REG_WEEKS ? 'the regular season' : 'week ' + done}` : 'Season not started'}${
        playoffCut ? ` · top ${playoffCut} make the playoffs` : ''}</div></div>
    ${lg.champion ? championBanner(lg) : ''}
    <div class="card" style="padding:6px 10px">
      <table class="std">
        <thead><tr><th style="width:54px">#</th><th>Team</th><th>Rec</th><th>PF</th><th>PA</th><th>Diff</th></tr></thead>
        <tbody>
          ${teams.map((t, i) => `<tr${playoffCut && i === playoffCut ? ' style="border-top:2px solid var(--line-2)"' : ''}>
            <td class="dim num" style="white-space:nowrap">${i + 1}${
              playoffCut && i < playoffCut ? '<span style="color:var(--gold)" title="Playoff berth"> ●</span>' : ''}</td>
            <td><div class="tm"><div class="swatch" style="background:${esc(t.color)}"></div>
              <div><div>${esc(t.name)}${t.id === S.myTeamId ? ' <span class="tiny" style="color:var(--mint)">you</span>' : ''}</div>
              <div class="tiny dim">${esc(t.owner)}</div></div></div></td>
            <td class="num">${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}</td>
            <td class="num">${fmt1(t.pf)}</td>
            <td class="num dim">${fmt1(t.pa)}</td>
            <td class="num" style="color:${t.pf - t.pa >= 0 ? 'var(--mint)' : 'var(--hot)'}">${t.pf - t.pa >= 0 ? '+' : ''}${fmt1(t.pf - t.pa)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** Playoff bracket: semifinals feeding the championship game. */
function bracketCard(lg) {
  const name = (id) => lg.teams.find((t) => t.id === id);
  const seedOf = (id) => lg.playoffs.seeds.indexOf(id) + 1;

  const round = (week, title) => {
    const pairs = lg.playoffs.bracket[week] || [];
    if (!pairs.length) return '';
    const res = lg.results[week];
    return `<div style="flex:1;min-width:190px">
      <div class="tiny dim" style="letter-spacing:.11em;text-transform:uppercase;font-weight:800;margin-bottom:8px">${title}</div>
      ${pairs.map(([a, b]) => {
        const m = res?.matchups?.find((x) => x.home === a && x.away === b);
        const row = (id, pts, won) => `<div class="slot-row" style="${won ? 'background:rgba(255,197,49,.10)' : ''}">
          <div class="slot-tag">${seedOf(id) || '–'}</div>
          <div style="min-width:0"><div class="nm" style="${won ? 'font-weight:800' : ''}">${esc(name(id)?.name || 'TBD')}</div></div>
          <div class="num" style="font-weight:700;color:${won ? 'var(--gold)' : 'var(--muted)'}">${pts != null ? fmt1(pts) : '–'}</div>
        </div>`;
        return `<div style="margin-bottom:10px">
          ${row(a, m?.homePts, m && m.winner === a)}
          ${row(b, m?.awayPts, m && m.winner === b)}
        </div>`;
      }).join('')}
    </div>`;
  };

  return `<div class="card" style="padding:18px;margin-bottom:14px">
    <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Playoff bracket</h3>
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      ${round(SEMI_WEEK, 'Semifinals')}
      ${round(FINAL_WEEK, 'Championship')}
    </div>
  </div>`;
}

/** Gold banner announcing the champion, reused on standings and league pages. */
function championBanner(lg) {
  const t = lg.teams.find((x) => x.id === lg.champion);
  if (!t) return '';
  return `<div class="card" style="padding:18px;margin-bottom:14px;display:flex;align-items:center;gap:16px;
      border-color:rgba(255,197,49,.4);background:linear-gradient(100deg,rgba(255,197,49,.12),transparent 60%)">
    <div style="font-size:34px">🏆</div>
    <div style="flex:1;min-width:0">
      <div class="tiny" style="letter-spacing:.16em;text-transform:uppercase;font-weight:800;color:var(--gold)">
        ${lg.settings.season} Champion</div>
      <div style="font-size:21px;font-weight:800;letter-spacing:-.025em">${esc(t.name)}</div>
      <div class="tiny dim">${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''} · ${fmt1(t.pf)} points for</div>
    </div>
    <button class="btn btn-sm" id="replay-cup">Replay ceremony</button>
  </div>`;
}

/* -------------------------------------------------------------- league view */

function renderLeagueInfo(page) {
  const lg = S.league;
  const weeksPlayed = Object.entries(lg.results).filter(([, r]) => r.recorded);

  page.innerHTML = `
    <div class="page-head"><h1>${esc(lg.name)}</h1>
      <div class="sub">${esc(SCORING_LABELS[lg.settings.scoring])} · ${lg.settings.rounds} rounds${
        lg.settings.dataMode === 'replay' ? ` · replaying ${lg.settings.season}` : ''}</div></div>

    ${lg.champion ? championBanner(lg) : ''}
    ${lg.playoffs ? bracketCard(lg) : ''}

    ${isCloud() ? `<div class="card" style="padding:18px;margin-bottom:14px">
      <div class="tiny dim" style="letter-spacing:.1em;text-transform:uppercase;font-weight:800">Invite code</div>
      <div style="font-family:ui-monospace,monospace;font-size:30px;font-weight:800;letter-spacing:.2em;color:var(--mint)">${esc(lg.code)}</div>
    </div>` : ''}

    ${weeksPlayed.length ? `<div class="card" style="padding:18px;margin-bottom:14px">
      <h3 style="margin:0 0 4px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Weekly high scores</h3>
      <p class="tiny dim" style="margin:0 0 10px">Tap any week to replay its ceremony.</p>
      ${weeksPlayed.map(([w, r]) => {
        const totals = Object.entries(r.scores).map(([id, sc]) => ({ id, t: sc.total })).sort((a, b) => b.t - a.t);
        const best = totals[0];
        const team = lg.teams.find((t) => t.id === best?.id);
        const margin = totals[1] ? best.t - totals[1].t : 0;
        const label = w > REG_WEEKS ? (Number(w) === SEMI_WEEK ? 'SF' : 'F') : 'W' + w;
        return `<div class="slot-row" style="cursor:pointer" data-week="${w}">
          <div class="slot-tag">${label}</div>
          <div style="min-width:0"><div class="nm">${esc(team?.name || '')}</div>
            <div class="sub">${esc(team?.owner || '')}${margin > 0 ? ` · +${fmt1(margin)} over the field` : ''}</div></div>
          <div class="num" style="font-weight:800;color:var(--gold)">${fmt1(best?.t || 0)}</div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <div class="card" style="padding:18px;margin-bottom:14px">
      <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Scoring rules</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px" class="tiny muted">
        <div>Passing yard · <b>0.04</b></div><div>Passing TD · <b>4</b></div>
        <div>Interception · <b>−2</b></div><div>Rushing yard · <b>0.1</b></div>
        <div>Rush/Rec TD · <b>6</b></div><div>Reception · <b>${{ standard: 0, half_ppr: 0.5, ppr: 1, ppr_bonus: 1 }[lg.settings.scoring]}</b></div>
        <div>Receiving yard · <b>0.1</b></div><div>Fumble lost · <b>−2</b></div>
        <div>FG 0–39 · <b>3</b></div><div>FG 40–49 · <b>4</b></div><div>FG 50+ · <b>5</b></div><div>PAT · <b>1</b></div>
      </div>
    </div>

    <div class="card" style="padding:18px">
      <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Data</h3>
      <p class="tiny muted" style="margin:0 0 14px;line-height:1.6">
        Player pool and rankings come from <b>nflverse</b> open data — ${POOL.players.length} players,
        valued on their ${POOL.basis} per-game production above replacement at each position.
        ${isCloud()
          ? 'Weekly scores are pulled from real NFL box scores by your Cloudflare Worker.'
          : lg.settings.dataMode === 'replay'
            ? `Every week is scored from the actual ${lg.settings.season} box scores embedded in this page —
               real bye weeks, real injuries, real 40-point outbursts. Nothing is randomised.`
            : `This league rolls weekly results from each player's real ${POOL.basis} averages with
               position-appropriate variance. Pick "replay" at league creation to use real box scores instead.`}
      </p>
      <button class="btn btn-sm" id="leave">${isCloud() ? 'Leave league' : 'Delete local league'}</button>
    </div>`;

  $$('[data-week]', page).forEach((r) => {
    r.onclick = () => { S.week = Number(r.dataset.week); celebrateWeek(S.week); };
  });

  $('#leave').onclick = () => {
    if (!confirm(isCloud() ? 'Leave this league?' : 'Delete this local league permanently?')) return;
    if (!isCloud()) Local.clear();
    if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
    S.league = null; S.myTeamId = null;
    render();
  };
}

/* ------------------------------------------------------------------- utils */

function initials(name) {
  return String(name).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* -------------------------------------------------------------------- boot */

function boot() {
  // Live clock + draft board refresh.
  clockTimer = setInterval(() => {
    if (!S.league || S.view !== 'draft') return;
    if (S.league.draft.status !== 'live') return;
    tickClock();
    const picks = S.league.draft.picks.length;
    if (picks !== S.lastPickCount) {
      S.lastPickCount = picks;
      renderClock(); renderBoard(); renderPool(); renderMyRoster(); renderTicker();
    }
  }, 250);

  render();
  if (S.league?.local) scheduleBots();
}

window.addEventListener('DOMContentLoaded', boot);
