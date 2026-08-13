/**
 * Fantasy football league API.
 *
 *   /api/auth/*      register / login  (PBKDF2 + HMAC session tokens)
 *   /api/leagues/*   create / join / read / mutate a league
 *   /api/players     the draftable player pool
 *   /api/rankings    prior-season fantasy production, for the draft board
 *   /api/ws/:id      live draft + scoreboard WebSocket
 *
 * All league state lives in a LeagueRoom Durable Object, which serialises
 * concurrent draft picks without any explicit locking.
 */

import { LeagueRoom, buildSchedule } from './league.js';
import { UserRegistry } from './registry.js';
import { StatsCache, currentSeason, draftSeason } from './stats.js';
import { signToken, verifyToken, randomId } from './auth.js';

export { LeagueRoom, UserRegistry, StatsCache };

const SESSION_DAYS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);

    try {
      const res = await route(request, env, ctx, url);
      return cors(res, env);
    } catch (err) {
      return cors(json({ error: String(err && err.message || err) }, 500), env);
    }
  },

  /** Cron-driven ingest. Heavy CSV parsing happens here, never on a request. */
  async scheduled(event, env, ctx) {
    const stub = env.STATS.get(env.STATS.idFromName('global'));
    ctx.waitUntil(stub.fetch(`https://stats/refresh?season=${draftSeason()}`));
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/api') {
    return json({
      service: 'fantasy-football-league',
      season: draftSeason(),
      statsSeason: currentSeason(),
      ok: true,
    });
  }

  // ---- WebSocket: /api/ws/:leagueId
  const wsMatch = path.match(/^\/api\/ws\/([\w-]+)$/);
  if (wsMatch) {
    const room = leagueStub(env, wsMatch[1]);
    return room.fetch(new Request(url.toString(), request));
  }

  // ---- Auth
  if (path === '/api/auth/register' || path === '/api/auth/login') {
    const body = await request.json().catch(() => ({}));
    const reg = registryStub(env);
    const res = await reg.fetch(`https://registry${path.replace('/api/auth', '')}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) return json(data, 400);

    const token = await signToken(
      { uid: data.user.id, exp: Date.now() + SESSION_DAYS * 864e5 },
      secret(env),
    );
    return json({ token, user: data.user });
  }

  if (path === '/api/me') {
    const user = await requireUser(request, env);
    if (!user) return json({ error: 'Not signed in.' }, 401);
    const reg = registryStub(env);
    const res = await reg.fetch(`https://registry/my-leagues?id=${user.uid}`);
    const { leagues } = await res.json();
    return json({ user: { id: user.uid }, leagues: leagues || [] });
  }

  // ---- Player data (public, cached)
  if (path === '/api/players') {
    const stub = statsStub(env);
    const res = await stub.fetch('https://stats/pool');
    return withCache(new Response(res.body, res), 3600);
  }

  if (path === '/api/rankings') {
    const season = Number(url.searchParams.get('season')) || currentSeason();
    const stub = statsStub(env);
    const res = await stub.fetch(`https://stats/rank?season=${season}`);
    return withCache(new Response(res.body, res), 3600);
  }

  if (path === '/api/stats/week') {
    const season = url.searchParams.get('season') || currentSeason();
    const week = url.searchParams.get('week') || 1;
    const stub = statsStub(env);
    const res = await stub.fetch(`https://stats/week?season=${season}&week=${week}`);
    return withCache(new Response(res.body, res), 300);
  }

  if (path === '/api/admin/refresh') {
    // Guarded by a shared secret so it cannot be used to burn CPU.
    if (url.searchParams.get('key') !== secret(env)) return json({ error: 'Forbidden' }, 403);
    const stub = statsStub(env);
    const season = url.searchParams.get('season') || draftSeason();
    const weeks = url.searchParams.get('weeks') === '1' ? '&weeks=1' : '';
    const res = await stub.fetch(`https://stats/refresh?season=${season}${weeks}`);
    return new Response(res.body, res);
  }

  // ---- Leagues
  if (path === '/api/leagues/create' && request.method === 'POST') {
    const user = await requireUser(request, env);
    if (!user) return json({ error: 'Sign in to create a league.' }, 401);

    const body = await request.json().catch(() => ({}));
    const reg = registryStub(env);
    const leagueId = randomId(10);

    const codeRes = await reg.fetch('https://registry/claim-code', {
      method: 'POST',
      body: JSON.stringify({ leagueId }),
      headers: { 'content-type': 'application/json' },
    });
    const { code, error } = await codeRes.json();
    if (error) return json({ error }, 400);

    const room = leagueStub(env, leagueId);
    const created = await room.fetch('https://league/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': user.uid },
      body: JSON.stringify({
        id: leagueId,
        code,
        name: body.name,
        commissionerId: user.uid,
        commissionerName: body.displayName,
        settings: body.settings || {},
      }),
    });
    const data = await created.json();
    if (data.error) return json(data, 400);

    await reg.fetch('https://registry/link-league', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.uid, leagueId, name: body.name, code }),
    });

    return json({ ok: true, leagueId, code, league: data.league });
  }

  if (path === '/api/leagues/join' && request.method === 'POST') {
    const user = await requireUser(request, env);
    if (!user) return json({ error: 'Sign in to join a league.' }, 401);

    const body = await request.json().catch(() => ({}));
    const reg = registryStub(env);
    const res = await reg.fetch(`https://registry/resolve-code?code=${encodeURIComponent(body.code || '')}`);
    const { leagueId, error } = await res.json();
    if (error) return json({ error }, 404);

    const room = leagueStub(env, leagueId);
    const joined = await room.fetch('https://league/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': user.uid },
      body: JSON.stringify({ displayName: body.displayName, teamName: body.teamName }),
    });
    const data = await joined.json();
    if (data.error) return json(data, 400);

    await reg.fetch('https://registry/link-league', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: user.uid, leagueId, name: data.league?.name, code: body.code,
      }),
    });

    return json({ ok: true, leagueId, league: data.league });
  }

  // ---- Everything else is scoped to one league: /api/leagues/:id/:action
  const m = path.match(/^\/api\/leagues\/([\w-]+)(?:\/(.+))?$/);
  if (m) {
    const [, leagueId, action = 'get'] = m;
    const user = await requireUser(request, env);

    const ALLOWED = new Set([
      'get', 'join', 'update-team', 'settings', 'start-draft', 'pick', 'queue',
      'pause-draft', 'lineup', 'chat', 'score', 'advance-week',
    ]);
    if (!ALLOWED.has(action)) return json({ error: 'Unknown action.' }, 404);
    if (action !== 'get' && !user) return json({ error: 'Sign in first.' }, 401);

    const room = leagueStub(env, leagueId);
    const res = await room.fetch(`https://league/${action}`, {
      method: request.method === 'GET' ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-user-id': user.uid } : {}),
      },
      body: request.method === 'GET' ? undefined : await request.text(),
    });
    return new Response(res.body, res);
  }

  return json({ error: 'Not found' }, 404);
}

// -------------------------------------------------------------------- helpers

function secret(env) {
  // SESSION_SECRET must be set via `wrangler secret put SESSION_SECRET`.
  return env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
}

async function requireUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return verifyToken(token, secret(env));
}

function leagueStub(env, id) {
  return env.LEAGUE.get(env.LEAGUE.idFromName(id));
}
function registryStub(env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName('global'));
}
function statsStub(env) {
  return env.STATS.get(env.STATS.idFromName('global'));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withCache(res, seconds) {
  const r = new Response(res.body, res);
  r.headers.set('cache-control', `public, max-age=${seconds}`);
  return r;
}

/**
 * CORS. ALLOWED_ORIGIN defaults to '*' so the page works from a file:// or
 * github.io origin out of the box; set it in wrangler.toml to lock it down.
 */
function cors(res, env) {
  const r = new Response(res.body, res);
  r.headers.set('access-control-allow-origin', env.ALLOWED_ORIGIN || '*');
  r.headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  r.headers.set('access-control-allow-headers', 'content-type,authorization');
  r.headers.set('access-control-max-age', '86400');
  return r;
}
