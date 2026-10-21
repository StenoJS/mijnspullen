'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE = 'ms_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400e3);
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(sha(token), userId, now.toISOString(), exp.toISOString());
  return { token, expires: exp };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.disabled, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row || row.disabled || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, _token: token };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function cookieHeader(token, expires, secure) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${expires.toUTCString()}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
const clearCookie = (secure) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

// Eenvoudige rate limit tegen brute force op login.
const fails = new Map();
function loginAllowed(key) {
  const f = fails.get(key);
  if (!f) return true;
  if (Date.now() - f.first > 15 * 60e3) { fails.delete(key); return true; }
  return f.count < 10;
}
function loginFailed(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
const loginOk = (key) => fails.delete(key);

module.exports = { hashPassword, verifyPassword, createSession, getUser, destroySession, cookieHeader, clearCookie, loginAllowed, loginFailed, loginOk, COOKIE };
