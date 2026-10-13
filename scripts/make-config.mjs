#!/usr/bin/env node
/**
 * Turn `.env` into `src/common/env.config.js`.
 *
 * A Chrome extension has no runtime environment: nothing can read `.env` from
 * inside one, so the only way a value configured once can reach the extension is
 * to be written into a module it imports. That is all this does.
 *
 * Deliberately dependency-free and deliberately small. A build step that can
 * fail in interesting ways, for two optional public values, would be a worse
 * trade than a script a reader can check in a minute.
 *
 * Usage:
 *   node scripts/make-config.mjs [path/to/.env]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const envPath = resolve(process.argv[2] ?? join(root, '.env'));
const outPath = join(root, 'src', 'common', 'env.config.js');

/** Keys this script understands. Anything else in `.env` is ignored. */
const KEYS = ['ADMIN_EMAIL', 'API_BASE'];

/**
 * A minimal `.env` reader: `KEY=value`, `#` comments, optional quotes.
 *
 * It parses the four lines this project actually uses rather than the whole
 * dotenv grammar — an extension does not need `${VAR}` expansion or multiline
 * values, and pretending to support them would invite a `.env` that this script
 * silently mis-reads.
 */
function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (KEYS.includes(key)) values[key] = value;
  }
  return values;
}

/** A JS string literal, or `null`. */
function literal(value) {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? 'null' : JSON.stringify(trimmed);
}

let raw = '';
try {
  raw = readFileSync(envPath, 'utf8');
} catch {
  console.error(`[config] No .env at ${envPath}.`);
  console.error('[config] Copy .env.example to .env, fill it in, and run this again.');
  process.exit(1);
}

const values = parseEnv(raw);

const file = `/**
 * Build-time configuration, generated from \`.env\` by \`npm run config\`.
 *
 * DO NOT EDIT BY HAND — the next \`npm run config\` overwrites it. Edit \`.env\`
 * (see \`.env.example\`) and regenerate.
 *
 * Nothing here is a secret, and nothing here authorizes anything: \`ADMIN_EMAIL\`
 * only pre-fills a form, and the backend decides permissions on every request.
 */

/** The administrator's email, for pre-filling the admin sign-in form. */
export const ADMIN_EMAIL = ${literal(values.ADMIN_EMAIL)};

/** The backend this build points at, or null to use the shipped default. */
export const API_BASE = ${literal(values.API_BASE)};
`;

writeFileSync(outPath, file, 'utf8');
console.log(`[config] Wrote ${outPath}`);
console.log(`[config] ADMIN_EMAIL: ${values.ADMIN_EMAIL ? 'set' : 'not set'}`);
console.log(`[config] API_BASE:    ${values.API_BASE || 'default'}`);
