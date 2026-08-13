/**
 * LeagueRoom — one Durable Object per league. Owns all league state and is the
 * single serialization point for the live draft, which is what makes a
 * concurrent snake draft correct without any locking.
 *
 * Live updates use the WebSocket Hibernation API so an idle league between
 * Sunday games costs nothing.
 */

import { randomId } from './auth.js';
import { inflate } from './stats.js';
import {
  DEFAULT_ROSTER, SCORING_PRESETS, expandRoster, scoreStatLine,
  scoreTeamDefense, slotAccepts, round2,
} from './scoring.js';

const TEAM_COLORS = [
  '#ff4d6d', '#4cc9f0', '#f7b801', '#7ae582', '#b892ff', '#ff8fab',
  '#00d4a0', '#ff9f1c', '#5390d9', '#f72585', '#48cae4', '#c77dff',
];

export class LeagueRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // ws -> { userId, teamId }
    for (const ws of ctx.getWebSockets()) {
      this.sessions.set(ws, ws.deserializeAttachment() || {});
    }
  }

  // ---------------------------------------------------------------- state

  async state() {
    if (!this._state) {
      this._state = (await this.ctx.storage.get('state')) || null;
    }
    return this._state;
  }

  async save(s) {
    this._state = s;
    await this.ctx.storage.put('state', s);
  }

  // ---------------------------------------------------------------- http

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleUpgrade(request, url);
    }

    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const userId = request.headers.get('x-user-id') || null;

    try {
      switch (url.pathname) {
        case '/create': return json(await this.create(body));
        case '/get': return json(await this.snapshot(userId));
        case '/join': return json(await this.join(userId, body));
        case '/update-team': return json(await this.updateTeam(userId, body));
        case '/settings': return json(await this.updateSettings(userId, body));
        case '/start-draft': return json(await this.startDraft(userId, body));
        case '/pick': return json(await this.makePick(userId, body, false));
        case '/queue': return json(await this.setQueue(userId, body));
        case '/pause-draft': return json(await this.pauseDraft(userId, body));
        case '/lineup': return json(await this.setLineup(userId, body));
        case '/chat': return json(await this.postChat(userId, body));
        case '/score': return json(await this.scoreWeek(body));
        case '/advance-week': return json(await this.advanceWeek(userId, body));
        default: return json({ error: 'not found' }, 404);
      }
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  }

  async handleUpgrade(request, url) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const meta = {
      userId: url.searchParams.get('userId') || null,
      teamId: url.searchParams.get('teamId') || null,
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);
    this.sessions.set(server, meta);

    const s = await this.state();
    if (s) {
      server.send(JSON.stringify({ type: 'state', state: await this.publicState(meta.userId) }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = this.sessions.get(ws) || {};

    // Keepalive only — all mutations go through HTTP so they are authenticated.
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* peer went away mid-send */ }
    }
  }

  async broadcastState(extra = null) {
    const state = await this.publicState(null);
    this.broadcast({ type: 'state', state, event: extra });
  }

  // ---------------------------------------------------------------- league lifecycle

  async create({ id, name, commissionerId, commissionerName, code, settings }) {
    if (await this.state()) return { error: 'League already exists.' };

    const s = {
      id,
      code,
      name: String(name || 'Untitled League').slice(0, 60),
      commissionerId,
      createdAt: Date.now(),
      settings: {
        season: settings?.season || new Date().getUTCFullYear(),
        scoring: settings?.scoring || 'half_ppr',
        rules: SCORING_PRESETS[settings?.scoring || 'half_ppr'],
        roster: settings?.roster || DEFAULT_ROSTER,
        teamCount: clamp(settings?.teamCount || 10, 2, 12),
        pickSeconds: clamp(settings?.pickSeconds || 60, 15, 600),
        rounds: 0, // derived at draft start
      },
      teams: [],
      draft: { status: 'pre', order: [], picks: [], current: null, queues: {} },
      lineups: {},
      schedule: null,
      results: {},
      currentWeek: 1,
      chat: [],
    };
    s.settings.rounds = expandRoster(s.settings.roster).length;

    await this.save(s);
    // The creator is automatically the first team.
    await this.join(commissionerId, { displayName: commissionerName });
    return { ok: true, league: await this.publicState(commissionerId) };
  }

  async join(userId, { displayName, teamName }) {
    const s = await this.state();
    if (!s) return { error: 'League not found.' };
    if (!userId) return { error: 'Sign in to join a league.' };

    const existing = s.teams.find((t) => t.userId === userId);
    if (existing) return { ok: true, teamId: existing.id, league: await this.publicState(userId) };

    if (s.draft.status !== 'pre') return { error: 'This league has already drafted.' };
    if (s.teams.length >= s.settings.teamCount) return { error: 'This league is full.' };

    const idx = s.teams.length;
    const owner = String(displayName || 'Manager').slice(0, 40);
    const team = {
      id: randomId(8),
      userId,
      owner,
      name: String(teamName || `${owner}'s Team`).slice(0, 40),
      color: TEAM_COLORS[idx % TEAM_COLORS.length],
      roster: [],       // playerIds
      slots: {},        // slotId -> playerId (current week lineup)
      wins: 0, losses: 0, ties: 0, pf: 0, pa: 0,
      joinedAt: Date.now(),
    };
    s.teams.push(team);
    await this.save(s);
    await this.broadcastState({ kind: 'join', team: team.name });
    return { ok: true, teamId: team.id, league: await this.publicState(userId) };
  }

  async updateTeam(userId, { name, color }) {
    const s = await this.state();
    const team = s?.teams.find((t) => t.userId === userId);
    if (!team) return { error: 'You are not in this league.' };
    if (name) team.name = String(name).slice(0, 40);
    if (color && /^#[0-9a-f]{6}$/i.test(color)) team.color = color;
    await this.save(s);
    await this.broadcastState();
    return { ok: true };
  }

  async updateSettings(userId, { settings }) {
    const s = await this.state();
    if (!s) return { error: 'League not found.' };
    if (s.commissionerId !== userId) return { error: 'Only the commissioner can change settings.' };
    if (s.draft.status !== 'pre') return { error: 'Settings are locked once the draft starts.' };

    if (settings.scoring && SCORING_PRESETS[settings.scoring]) {
      s.settings.scoring = settings.scoring;
      s.settings.rules = { ...SCORING_PRESETS[settings.scoring], ...(settings.rules || {}) };
    } else if (settings.rules) {
      s.settings.rules = { ...s.settings.rules, ...settings.rules };
    }
    if (settings.roster) s.settings.roster = settings.roster;
    if (settings.teamCount) s.settings.teamCount = clamp(settings.teamCount, Math.max(2, s.teams.length), 12);
    if (settings.pickSeconds) s.settings.pickSeconds = clamp(settings.pickSeconds, 15, 600);
    if (settings.name) s.name = String(settings.name).slice(0, 60);
    s.settings.rounds = expandRoster(s.settings.roster).length;

    await this.save(s);
    await this.broadcastState();
    return { ok: true };
  }

  // ---------------------------------------------------------------- draft

  async startDraft(userId, { randomize = true }) {
    const s = await this.state();
    if (!s) return { error: 'League not found.' };
    if (s.commissionerId !== userId) return { error: 'Only the commissioner can start the draft.' };
    if (s.draft.status === 'live') return { error: 'The draft is already running.' };
    if (s.teams.length < 2) return { error: 'You need at least 2 teams to draft.' };

    if (s.draft.status === 'pre') {
      const ids = s.teams.map((t) => t.id);
      s.draft.order = randomize ? shuffle(ids) : ids;
      s.draft.picks = [];
      s.settings.rounds = expandRoster(s.settings.roster).length;
    }
    s.draft.status = 'live';
    s.draft.current = this.nextPickSlot(s, s.draft.picks.length);
    await this.save(s);
    await this.armClock(s);
    await this.broadcastState({ kind: 'draft-start' });
    return { ok: true };
  }

  async pauseDraft(userId, { paused }) {
    const s = await this.state();
    if (s.commissionerId !== userId) return { error: 'Only the commissioner can pause the draft.' };
    if (paused) {
      s.draft.status = 'paused';
      await this.ctx.storage.deleteAlarm();
    } else {
      s.draft.status = 'live';
      s.draft.current = this.nextPickSlot(s, s.draft.picks.length);
      await this.armClock(s);
    }
    await this.save(s);
    await this.broadcastState({ kind: paused ? 'draft-pause' : 'draft-resume' });
    return { ok: true };
  }

  /** Snake order: odd rounds forward, even rounds reversed. */
  nextPickSlot(s, overall) {
    const n = s.draft.order.length;
    const total = n * s.settings.rounds;
    if (overall >= total) return null;

    const round = Math.floor(overall / n) + 1;
    const posInRound = overall % n;
    const idx = round % 2 === 1 ? posInRound : n - 1 - posInRound;

    return {
      overall: overall + 1,
      round,
      pickInRound: posInRound + 1,
      teamId: s.draft.order[idx],
      deadline: Date.now() + s.settings.pickSeconds * 1000,
    };
  }

  async armClock(s) {
    if (s.draft.status === 'live' && s.draft.current) {
      await this.ctx.storage.setAlarm(s.draft.current.deadline);
    }
  }

  /** Pick clock expiry — auto-draft for whoever is on the clock. */
  async alarm() {
    const s = await this.state();
    if (!s || s.draft.status !== 'live' || !s.draft.current) return;
    if (Date.now() < s.draft.current.deadline - 250) {
      // Alarm fired early (clock was extended); re-arm.
      await this.armClock(s);
      return;
    }
    await this.makePick(null, { teamId: s.draft.current.teamId, playerId: null }, true);
  }

  async makePick(userId, { teamId, playerId }, auto) {
    const s = await this.state();
    if (!s) return { error: 'League not found.' };
    if (s.draft.status !== 'live') return { error: 'The draft is not running.' };

    const cur = s.draft.current;
    if (!cur) return { error: 'The draft is complete.' };

    const team = s.teams.find((t) => t.id === cur.teamId);
    if (!team) return { error: 'Team not found.' };

    // Humans may only pick for themselves, and only on their turn.
    if (!auto) {
      if (team.userId !== userId) return { error: "It is not your turn to pick." };
      if (teamId && teamId !== cur.teamId) return { error: 'That is not the team on the clock.' };
    }

    const taken = new Set(s.draft.picks.map((p) => p.playerId));
    let chosen = playerId;

    if (chosen && taken.has(chosen)) {
      if (!auto) return { error: 'That player is already drafted.' };
      chosen = null;
    }

    // Auto-pick: honour the team's queue, else best available by ranking.
    if (!chosen) {
      const queue = (s.draft.queues[cur.teamId] || []).filter((id) => !taken.has(id));
      chosen = queue[0] || (await this.bestAvailable(s, team, taken));
    }
    if (!chosen) return { error: 'No available players remain.' };

    const pick = {
      overall: cur.overall,
      round: cur.round,
      pickInRound: cur.pickInRound,
      teamId: cur.teamId,
      playerId: chosen,
      at: Date.now(),
      auto: !!auto,
    };
    s.draft.picks.push(pick);
    team.roster.push(chosen);
    s.draft.queues[cur.teamId] = (s.draft.queues[cur.teamId] || []).filter((id) => id !== chosen);

    s.draft.current = this.nextPickSlot(s, s.draft.picks.length);

    if (!s.draft.current) {
      s.draft.status = 'done';
      await this.ctx.storage.deleteAlarm();
      this.autoFillLineups(s);
      if (!s.schedule) s.schedule = buildSchedule(s.teams.map((t) => t.id));
    } else {
      await this.armClock(s);
    }

    await this.save(s);
    await this.broadcastState({ kind: 'pick', pick, teamName: team.name, teamColor: team.color });
    return { ok: true, pick };
  }

  /**
   * Best available on value over replacement, adjusted for roster needs.
   * Mirrors the client's bot so a cloud auto-pick and a local one agree.
   */
  async bestAvailable(s, team, taken) {
    const ranks = await this.rankings(s);
    const slots = expandRoster(s.settings.roster).filter((sl) => sl.starter);

    const want = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
      want[pos] = slots.filter((x) => slotAccepts(x.kind, pos)).length;
    }
    const counts = {};
    for (const pid of team.roster) {
      const pos = this.posCache?.[pid];
      if (pos) counts[pos] = (counts[pos] || 0) + 1;
    }

    // Kickers and defenses only become worth a pick in the last two rounds.
    const total = s.draft.order.length * s.settings.rounds;
    const lateGame = s.draft.picks.length >= total - s.draft.order.length * 2;

    let best = null, bestScore = -Infinity;
    for (const r of ranks) {
      if (taken.has(r.id) || team.roster.includes(r.id)) continue;
      const have = counts[r.pos] || 0;
      const w = want[r.pos] || 0;

      let score = r.value;
      if (have < w) score += 3.2;                 // still needs a starter here
      if (have >= w + 2) score -= 4.5;            // stop hoarding one position
      if ((r.pos === 'K' || r.pos === 'DST') && !lateGame) score -= 9;

      if (score > bestScore) { bestScore = score; best = r.id; }
    }
    return best;
  }

  async rankings(s) {
    if (this._ranks) return this._ranks;
    const season = s.settings.season;
    const stub = this.env.STATS.idFromName('global');
    const cache = this.env.STATS.get(stub);

    // Prior season totals are the ranking basis; pre-kickoff that is all there is.
    let res = await cache.fetch(`https://stats/rank?season=${season - 1}`);
    let data = await res.json().catch(() => null);
    if (!data || !data.rows) {
      res = await cache.fetch(`https://stats/rank?season=${season - 2}`);
      data = await res.json().catch(() => null);
    }

    // The stat file covers every player who took a snap, including linemen and
    // people who have since retired. The pool is the roster-backed truth for
    // who is actually draftable, so intersect against it.
    let draftable = null;
    let poolPos = null;
    try {
      const poolRes = await cache.fetch('https://stats/pool');
      const pool = await poolRes.json();
      if (pool && pool.players && pool.players.length) {
        draftable = new Set(pool.players.map((p) => p.id));
        poolPos = new Map(pool.players.map((p) => [p.id, p.pos]));
      }
    } catch { /* pool unavailable — fall back to a position filter below */ }

    const FANTASY = ['QB', 'RB', 'WR', 'TE', 'K'];
    const rows = ((data && data.rows) || []).filter((row) =>
      draftable ? draftable.has(row[0]) : FANTASY.includes(row[1]));

    const rules = s.settings.rules;
    const scored = rows.map((row) => {
      // rank rows are [id, pos, team, games, name, ...stats]
      const stat = inflate([row[0], row[1], row[2], ...row.slice(5)]);
      const { points } = scoreStatLine(stat, rules);
      const g = Math.max(1, row[3] || 1);
      // Roster position wins over the stat-file position. The stat file calls
      // fullbacks "FB", which would otherwise form a one-man replacement tier
      // and make a blocking fullback look like a first-round pick.
      const pos = (poolPos && poolPos.get(row[0])) || row[1];
      return { id: row[0], pos, team: row[2], g, name: row[4], points, ppg: points / g };
    }).filter((r) => r.g >= 3 && FANTASY.includes(r.pos));

    // Value over replacement, matching the client's board. Ranking on raw
    // points would send every quarterback in round one.
    const teams = Math.max(2, s.teams.length || s.settings.teamCount || 10);
    const STARTERS = { QB: 1, RB: 2.5, WR: 3.5, TE: 1.2, K: 1 };
    const byPos = {};
    for (const r of scored) (byPos[r.pos] = byPos[r.pos] || []).push(r);

    const repl = {};
    for (const [pos, arr] of Object.entries(byPos)) {
      arr.sort((a, b) => b.ppg - a.ppg);
      // Kickers get streamed, so their replacement level sits near the top.
      const n = pos === 'K' ? 3 : Math.round(teams * (STARTERS[pos] || 1));
      repl[pos] = arr[Math.min(arr.length - 1, Math.max(0, n - 1))].ppg;
    }
    for (const r of scored) r.value = r.ppg - (repl[r.pos] || 0);

    // Team defenses are draftable but never appear in the player stat file.
    const dstTeams = [...new Set(scored.map((r) => r.team))].filter(Boolean);
    for (const t of dstTeams) {
      scored.push({ id: `DST_${t}`, pos: 'DST', team: t, g: 17, name: `${t} Defense`, points: 0, ppg: 8, value: -0.5 });
    }

    const ranked = scored.sort((a, b) => b.value - a.value);
    this.posCache = Object.fromEntries(ranked.map((r) => [r.id, r.pos]));
    this._ranks = ranked;
    return ranked;
  }

  async setQueue(userId, { playerIds }) {
    const s = await this.state();
    const team = s?.teams.find((t) => t.userId === userId);
    if (!team) return { error: 'You are not in this league.' };
    s.draft.queues[team.id] = (playerIds || []).slice(0, 50);
    await this.save(s);
    return { ok: true };
  }

  // ---------------------------------------------------------------- lineups & scoring

  autoFillLineups(s) {
    // Only starting slots are recorded; anyone unassigned is on the bench.
    const slots = expandRoster(s.settings.roster).filter((sl) => sl.starter);
    for (const team of s.teams) {
      const used = new Set();
      team.slots = {};
      for (const sl of slots) {
        for (const pid of team.roster) {
          if (used.has(pid)) continue;
          const pos = this.posCache?.[pid] || guessPos(pid);
          if (!slotAccepts(sl.kind, pos)) continue;
          team.slots[sl.id] = pid;
          used.add(pid);
          break;
        }
      }
    }
  }

  async setLineup(userId, { week, slots }) {
    const s = await this.state();
    const team = s?.teams.find((t) => t.userId === userId);
    if (!team) return { error: 'You are not in this league.' };

    const wk = Number(week) || s.currentWeek;
    const owned = new Set(team.roster);
    const clean = {};
    const used = new Set();

    for (const [slotId, pid] of Object.entries(slots || {})) {
      if (!pid) continue;
      if (!owned.has(pid)) return { error: 'You can only start players on your roster.' };
      if (used.has(pid)) return { error: 'A player cannot fill two slots.' };
      used.add(pid);
      clean[slotId] = pid;
    }

    if (!s.lineups[wk]) s.lineups[wk] = {};
    s.lineups[wk][team.id] = clean;
    team.slots = clean;
    await this.save(s);
    await this.broadcastState();
    return { ok: true };
  }

  /** Score a week from cached nflverse stats and settle matchups. */
  async scoreWeek({ week }) {
    const s = await this.state();
    if (!s) return { error: 'League not found.' };
    const wk = Number(week) || s.currentWeek;
    const season = s.settings.season;

    const stub = this.env.STATS.idFromName('global');
    const cache = this.env.STATS.get(stub);
    const res = await cache.fetch(`https://stats/week?season=${season}&week=${wk}`);
    const data = await res.json().catch(() => null);

    if (!data || !data.rows) {
      return { ok: true, week: wk, played: false, reason: `No stats published yet for ${season} week ${wk}.` };
    }

    const byPlayer = new Map();
    const byTeamDef = new Map();
    for (const row of data.rows) {
      const stat = inflate(row);
      byPlayer.set(stat.player_id, stat);
      if (!byTeamDef.has(stat.team)) byTeamDef.set(stat.team, []);
      byTeamDef.get(stat.team).push(stat);
    }

    const rules = s.settings.rules;
    const slots = expandRoster(s.settings.roster);
    const starters = new Set(slots.filter((sl) => sl.starter).map((sl) => sl.id));
    const scores = {};

    for (const team of s.teams) {
      const lineup = (s.lineups[wk] && s.lineups[wk][team.id]) || team.slots || {};
      const detail = [];
      let total = 0;

      for (const [slotId, pid] of Object.entries(lineup)) {
        if (!starters.has(slotId)) continue;
        let scored;
        if (pid.startsWith('DST_')) {
          scored = scoreTeamDefense(byTeamDef.get(pid.slice(4)) || [], rules);
        } else {
          const stat = byPlayer.get(pid);
          scored = stat ? scoreStatLine(stat, rules) : { points: 0, parts: [] };
        }
        total += scored.points;
        detail.push({ slotId, playerId: pid, points: scored.points, parts: scored.parts });
      }
      scores[team.id] = { total: round2(total), detail };
    }

    const matchups = (s.schedule && s.schedule[wk - 1]) || [];
    const settled = matchups.map(([a, b]) => {
      const sa = scores[a]?.total || 0;
      const sb = scores[b]?.total || 0;
      return { home: a, away: b, homePts: sa, awayPts: sb, winner: sa === sb ? null : (sa > sb ? a : b) };
    });

    s.results[wk] = { scores, matchups: settled, at: Date.now() };
    await this.save(s);
    await this.broadcastState({ kind: 'scores', week: wk });
    return { ok: true, week: wk, played: true, scores, matchups: settled };
  }

  /** Commissioner advances the week, locking in records. */
  async advanceWeek(userId, { week }) {
    const s = await this.state();
    if (s.commissionerId !== userId) return { error: 'Only the commissioner can advance the week.' };

    const wk = Number(week) || s.currentWeek;
    const scored = await this.scoreWeek({ week: wk });
    // Before kickoff there are no box scores yet — say so instead of silently
    // advancing to a week with no results.
    if (scored && scored.played === false) {
      return { ok: true, week: wk, played: false, reason: scored.reason };
    }
    const fresh = await this.state();
    const result = fresh.results[wk];

    if (result && !result.recorded) {
      for (const m of result.matchups) {
        const home = fresh.teams.find((t) => t.id === m.home);
        const away = fresh.teams.find((t) => t.id === m.away);
        if (!home || !away) continue;
        home.pf = round2(home.pf + m.homePts); home.pa = round2(home.pa + m.awayPts);
        away.pf = round2(away.pf + m.awayPts); away.pa = round2(away.pa + m.homePts);
        if (m.winner === home.id) { home.wins++; away.losses++; }
        else if (m.winner === away.id) { away.wins++; home.losses++; }
        else { home.ties++; away.ties++; }
      }
      result.recorded = true;
      fresh.currentWeek = wk + 1;
      await this.save(fresh);
    }

    await this.broadcastState({ kind: 'week-advance', week: wk });
    return { ok: true, week: wk, result };
  }

  async postChat(userId, { text }) {
    const s = await this.state();
    const team = s?.teams.find((t) => t.userId === userId);
    if (!team) return { error: 'You are not in this league.' };
    const msg = {
      id: randomId(6),
      teamId: team.id,
      name: team.name,
      color: team.color,
      text: String(text || '').slice(0, 300),
      at: Date.now(),
    };
    if (!msg.text.trim()) return { error: 'Message is empty.' };
    s.chat.push(msg);
    if (s.chat.length > 200) s.chat = s.chat.slice(-200);
    await this.save(s);
    this.broadcast({ type: 'chat', message: msg });
    return { ok: true };
  }

  async snapshot(userId) {
    const s = await this.state();
    if (!s) return { error: 'League not found.' };
    return { league: await this.publicState(userId) };
  }

  /** State as sent to clients — password-free by construction, plus live clock. */
  async publicState(userId) {
    const s = await this.state();
    if (!s) return null;
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      commissionerId: s.commissionerId,
      settings: s.settings,
      teams: s.teams,
      draft: {
        ...s.draft,
        // Send remaining ms so clients need no clock sync.
        msLeft: s.draft.current ? Math.max(0, s.draft.current.deadline - Date.now()) : 0,
      },
      lineups: s.lineups,
      schedule: s.schedule,
      results: s.results,
      currentWeek: s.currentWeek,
      chat: s.chat.slice(-60),
      serverTime: Date.now(),
    };
  }
}

// -------------------------------------------------------------------- helpers

/** Circle-method round robin; returns an array of weeks, each a list of pairs. */
export function buildSchedule(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 === 1) ids.push(null); // bye marker
  const n = ids.length;
  const rounds = [];

  for (let r = 0; r < (n - 1) * 2; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      if (a && b) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    // Rotate all but the first entry.
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

function guessPos(pid) {
  return pid.startsWith('DST_') ? 'DST' : 'WR';
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || lo));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status: body && body.error && status === 200 ? 400 : status,
    headers: { 'content-type': 'application/json' },
  });
}
