/**
 * The local protection password.
 *
 * What this is, and what it is not, matters:
 *
 *  - It is a **device lock**. It stops a change to Protection being a single
 *    click — the same intent as the Android app's Block-tab password, and enough
 *    for a shared or borrowed machine.
 *  - It is **not** a secret guarding the extension. Anything stored in a browser
 *    profile is readable from that profile, and an extension cannot defend
 *    itself against the person sitting at it. Treating this as strong
 *    authentication would be a false claim, so the UI does not make one.
 *
 * The password itself is never stored. A random salt is generated per install
 * and only a PBKDF2-SHA256 hash is written, so the stored record cannot be read
 * back or compared against a password list. Verification is a constant-time
 * comparison, and every failure returns the same answer: the caller cannot use
 * this to learn anything about the password.
 */

import { PASSWORD, STORAGE } from './constants.js';
import { readLocal, writeLocal } from './settings.js';

/** A coded error, so a caller can word the refusal. */
function passwordError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Reject anything that could not be a usable password.
 *
 * Length is checked against the code points on purpose: a length in UTF-16 code
 * units would count an emoji as two, so a four-emoji password would be accepted
 * as eight characters — a smaller space than the rules advertise.
 */
export function validatePassword(value) {
  if (typeof value !== 'string') {
    throw passwordError('invalid_password', 'Enter a password.');
  }
  const length = [...value].length;
  if (length < PASSWORD.minLength) {
    throw passwordError('password_too_short', `Use at least ${PASSWORD.minLength} characters.`);
  }
  if (length > PASSWORD.maxLength) {
    throw passwordError('password_too_long', `Use at most ${PASSWORD.maxLength} characters.`);
  }
  return value;
}

// ── Encoding ──────────────────────────────────────────────────────────────

/** Bytes -> base64, the shape the stored record keeps. */
function encode(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function decode(value) {
  if (typeof value !== 'string') return null;
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * Compare two byte arrays without early exit.
 *
 * A plain `===` on the encoded strings stops at the first differing character,
 * which leaks how much of a guess was correct. The length is folded into the
 * result rather than returned separately, so a wrong length is indistinguishable
 * from a wrong value.
 */
function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Derive the PBKDF2-SHA256 hash of a password under a salt. */
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

// ── The stored record ─────────────────────────────────────────────────────

/** Is a password set on this device? */
export async function hasPassword() {
  const record = await readLocal(STORAGE.password, null);
  return Boolean(record && typeof record.hash === 'string' && typeof record.salt === 'string');
}

/** Read the stored record, or null. Exported for the UI's status line only. */
export async function getPasswordRecord() {
  const record = await readLocal(STORAGE.password, null);
  return record && record.hash ? record : null;
}

/** Set (or replace) the password. Throws a coded error on an unusable value. */
export async function setPassword(password) {
  const clean = validatePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(clean, salt, PASSWORD.iterations);
  const record = {
    version: 1,
    algorithm: PASSWORD.algorithm,
    iterations: PASSWORD.iterations,
    salt: encode(salt),
    hash: encode(hash),
    at: Date.now(),
  };
  await writeLocal(STORAGE.password, record);
  return record;
}

/**
 * Does this password match the stored one?
 *
 * Returns false for every failure — no password set, a malformed record, an
 * empty guess — so a caller cannot tell "wrong" from "not set" by the answer.
 */
export async function verifyPassword(password) {
  const record = await getPasswordRecord();
  if (!record) return false;
  const salt = decode(record.salt);
  const stored = decode(record.hash);
  if (!salt || !stored || typeof password !== 'string') return false;
  const iterations = Number.isInteger(record.iterations) ? record.iterations : PASSWORD.iterations;
  const candidate = await derive(password, salt, iterations);
  return constantTimeEqual(candidate, stored);
}

/** Forget the password. */
export async function clearPassword() {
  await writeLocal(STORAGE.password, null);
}

/** Has the first-run offer been answered (by creating a password or skipping)? */
export async function isOnboarded() {
  return Boolean(await readLocal(STORAGE.onboarded, false));
}

export async function markOnboarded() {
  await writeLocal(STORAGE.onboarded, true);
}
