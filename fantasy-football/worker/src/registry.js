/**
 * UserRegistry — singleton Durable Object holding the global indexes that
 * cannot live inside a per-league object: accounts, and the invite-code ->
 * league-id mapping.
 */

import { hashPassword, verifyPassword, randomId, inviteCode } from './auth.js';

export class UserRegistry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    switch (url.pathname) {
      case '/register': return json(await this.register(body));
      case '/login': return json(await this.login(body));
      case '/user': return json(await this.getUser(url.searchParams.get('id')));
      case '/claim-code': return json(await this.claimCode(body));
      case '/resolve-code': return json(await this.resolveCode(url.searchParams.get('code')));
      case '/link-league': return json(await this.linkLeague(body));
      case '/unlink-league': return json(await this.unlinkLeague(body));
      case '/my-leagues': return json(await this.myLeagues(url.searchParams.get('id')));
      default: return json({ error: 'not found' }, 404);
    }
  }

  async register({ email, password, displayName }) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Enter a valid email address.' };
    if (typeof password !== 'string' || password.length < 8) {
      return { error: 'Password must be at least 8 characters.' };
    }
    const name = String(displayName || '').trim().slice(0, 40) || email.split('@')[0];

    if (await this.ctx.storage.get(`email:${email}`)) {
      return { error: 'That email is already registered. Try signing in.' };
    }

    const { hash, salt } = await hashPassword(password);
    const user = {
      id: randomId(12),
      email,
      displayName: name,
      hash,
      salt,
      createdAt: Date.now(),
      leagues: [],
    };
    await this.ctx.storage.put(`user:${user.id}`, user);
    await this.ctx.storage.put(`email:${email}`, user.id);
    return { user: publicUser(user) };
  }

  async login({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    const id = await this.ctx.storage.get(`email:${email}`);
    // Same message for unknown email and bad password — no account enumeration.
    const fail = { error: 'Email or password is incorrect.' };
    if (!id) return fail;

    const user = await this.ctx.storage.get(`user:${id}`);
    if (!user) return fail;
    if (!(await verifyPassword(String(password || ''), user.hash, user.salt))) return fail;

    return { user: publicUser(user) };
  }

  async getUser(id) {
    const user = await this.ctx.storage.get(`user:${id}`);
    return user ? { user: publicUser(user) } : { error: 'not found' };
  }

  /** Reserve a unique invite code for a new league. */
  async claimCode({ leagueId }) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = inviteCode();
      if (await this.ctx.storage.get(`code:${code}`)) continue;
      await this.ctx.storage.put(`code:${code}`, leagueId);
      return { code };
    }
    return { error: 'Could not allocate an invite code. Try again.' };
  }

  async resolveCode(code) {
    const leagueId = await this.ctx.storage.get(`code:${String(code || '').toUpperCase()}`);
    return leagueId ? { leagueId } : { error: 'No league found with that code.' };
  }

  async linkLeague({ userId, leagueId, name, code }) {
    const user = await this.ctx.storage.get(`user:${userId}`);
    if (!user) return { error: 'not found' };
    user.leagues = (user.leagues || []).filter((l) => l.id !== leagueId);
    user.leagues.push({ id: leagueId, name, code });
    await this.ctx.storage.put(`user:${userId}`, user);
    return { ok: true, leagues: user.leagues };
  }

  async unlinkLeague({ userId, leagueId }) {
    const user = await this.ctx.storage.get(`user:${userId}`);
    if (!user) return { error: 'not found' };
    user.leagues = (user.leagues || []).filter((l) => l.id !== leagueId);
    await this.ctx.storage.put(`user:${userId}`, user);
    return { ok: true, leagues: user.leagues };
  }

  async myLeagues(userId) {
    const user = await this.ctx.storage.get(`user:${userId}`);
    return { leagues: (user && user.leagues) || [] };
  }
}

function publicUser(u) {
  return { id: u.id, email: u.email, displayName: u.displayName, leagues: u.leagues || [] };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status: body && body.error && status === 200 ? 400 : status,
    headers: { 'content-type': 'application/json' },
  });
}
