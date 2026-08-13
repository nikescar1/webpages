/**
 * Password hashing and session tokens, built on WebCrypto only
 * (Workers has no bcrypt/argon2 — PBKDF2-SHA256 is the supported primitive).
 */

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 150_000;

export function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashPassword(password, saltB64 = null) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: b64(bits), salt: b64(salt) };
}

export async function verifyPassword(password, hash, salt) {
  const got = await hashPassword(password, salt);
  return timingSafeEqual(got.hash, hash);
}

/** Constant-time string compare, so token/hash checks do not leak by timing. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

/** Sign a stateless session token: base64(payload).base64(hmac). */
export async function signToken(payload, secret) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64(sig)}`;
}

export async function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  if (!timingSafeEqual(sig, b64(expected))) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64(body)));
  } catch {
    return null;
  }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

/** Human-friendly league invite code — no vowels, so it cannot spell anything. */
export function inviteCode() {
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
