/**
 * The `.env` -> `src/common/env.config.js` generator.
 *
 * This is the one thing here that writes into the repository, so it is tested by
 * running it for real and restoring the committed file afterwards. A test that
 * only asserted on the script's source would not catch the failure that matters:
 * a generator that runs cleanly and bakes in the wrong value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, 'src/common/env.config.js');
const SCRIPT = resolve(ROOT, 'scripts/make-config.mjs');

/**
 * Run the generator against `envText`, then put the committed file back.
 *
 * `inspect` runs while the GENERATED file is still on disk, which is the only
 * moment it can be imported — restoring first would import the default file and
 * pass for the wrong reason.
 */
async function generate(envText, inspect) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-config-'));
  const original = readFileSync(CONFIG, 'utf8');
  try {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, envText, 'utf8');
    execFileSync(process.execPath, [SCRIPT, envPath], { cwd: ROOT, stdio: 'pipe' });
    const generated = readFileSync(CONFIG, 'utf8');
    if (inspect) await inspect(generated);
    return generated;
  } finally {
    writeFileSync(CONFIG, original, 'utf8');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the administrator email in .env reaches the generated module', async () => {
  await generate(
    [
      '# a comment, which is not a setting',
      '',
      'ADMIN_EMAIL = admin@example.com',
      'API_BASE="https://api.example.com"',
      'SOMETHING_ELSE=ignored',
    ].join('\n'),
    async (generated) => {
      assert.match(generated, /export const ADMIN_EMAIL = "admin@example\.com";/);
      assert.match(generated, /export const API_BASE = "https:\/\/api\.example\.com";/);
      assert.ok(!generated.includes('ignored'), 'a key the script does not know must not be copied');
      assert.ok(!generated.includes('# a comment'), 'comments must not leak into the module');

      // And it has to be a REAL module: the values must survive an import, which
      // is the only way the admin page ever sees them.
      const url = `${pathToFileURL(CONFIG).href}?v=${Date.now()}`;
      const module = await import(url);
      assert.equal(module.ADMIN_EMAIL, 'admin@example.com');
      assert.equal(module.API_BASE, 'https://api.example.com');
    }
  );
});

test('an empty .env yields null rather than an empty string', async () => {
  const generated = await generate(['ADMIN_EMAIL=', 'API_BASE='].join('\n'));
  // An empty string would pre-fill the form with nothing and read as "set" in
  // any truthiness check, which is worse than an explicit null.
  assert.match(generated, /export const ADMIN_EMAIL = null;/);
  assert.match(generated, /export const API_BASE = null;/);
});

test('no .env at all fails loudly instead of writing a blank config', () => {
  const original = readFileSync(CONFIG, 'utf8');
  try {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, join(tmpdir(), 'cv-does-not-exist.env')], {
        cwd: ROOT,
        stdio: 'pipe',
      });
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 1, 'a missing .env must exit non-zero');
    assert.equal(readFileSync(CONFIG, 'utf8'), original, 'and must not touch the committed config');
  } finally {
    writeFileSync(CONFIG, original, 'utf8');
  }
});

test('the committed config loads without ever running the generator', async () => {
  // The extension has no build step, so this file must be present and parseable
  // in the repository — the admin page imports it on load. Its VALUES are the
  // deployment's business (null until `.env` is used), so what is asserted here
  // is the SHAPE, not a particular address.
  const url = `${pathToFileURL(CONFIG).href}?v=${Date.now()}`;
  const module = await import(url);
  assert.ok('ADMIN_EMAIL' in module, 'ADMIN_EMAIL must be exported');
  assert.ok('API_BASE' in module, 'API_BASE must be exported');
  assert.ok(
    module.ADMIN_EMAIL === null || typeof module.ADMIN_EMAIL === 'string',
    'ADMIN_EMAIL must be a string or null'
  );
  assert.ok(
    module.API_BASE === null || typeof module.API_BASE === 'string',
    'API_BASE must be a string or null'
  );
});

// ── The mistake this actually has to survive ─────────────────────────────
//
// The BACKEND server's `.env` is a tempting thing to drop in next to the
// extension, and it carries live secrets — a database URL, a JWT secret, an S3
// key, a password hash. `.env` is gitignored, so it would not be committed, but
// this module IS, so the generator must be incapable of copying anything but the
// two keys it knows.

const BACKEND_SHAPED_ENV = [
  'NODE_ENV=production',
  'DATABASE_URL=postgres://cvuser:s3cr3t@db.internal:5432/clearview',
  'JWT_SECRET=jwt-signing-secret-value',
  'SUPER_ADMIN_PASSWORD_HASH=$2b$10$abcdefghijklmnopqrstuv',
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
  'AWS_SECRET_ACCESS_KEY=aws-secret-access-value',
  'GOODPOST_HASH_PEPPER=hash-pepper-value',
  'FIREBASE_PROJECT_ID=clearview-28413',
  'PUBLIC_BASE_URL=https://clearview-1neb.onrender.com',
].join('\n');

test('a backend .env dropped in by mistake leaks no secret into the module', async () => {
  await generate(BACKEND_SHAPED_ENV, async (generated) => {
    for (const secret of [
      's3cr3t',
      'jwt-signing-secret-value',
      'abcdefghijklmnopqrstuv',
      'AKIAIOSFODNN7EXAMPLE',
      'aws-secret-access-value',
      'hash-pepper-value',
      'db.internal',
    ]) {
      assert.ok(!generated.includes(secret), `a secret reached env.config.js: ${secret}`);
    }
    // None of those keys is one the extension has, so nothing is filled in.
    assert.match(generated, /export const ADMIN_EMAIL = null;/);
    assert.match(generated, /export const API_BASE = null;/);
  });
});

test('the two known keys still resolve out of a mixed file', async () => {
  await generate(
    ['DATABASE_URL=postgres://cvuser:s3cr3t@db.internal/x', 'ADMIN_EMAIL=admin@example.com', 'JWT_SECRET=a-secret', 'API_BASE=https://my.backend.test'].join('\n'),
    async (generated) => {
      assert.match(generated, /export const ADMIN_EMAIL = "admin@example\.com";/);
      assert.match(generated, /export const API_BASE = "https:\/\/my\.backend\.test";/);
      assert.ok(!generated.includes('s3cr3t'), 'the database URL must not be carried over');
      assert.ok(!generated.includes('a-secret'), 'the JWT secret must not be carried over');
    }
  );
});

test('the extension ships no credential, and .env is not read at runtime', () => {
  const committed = readFileSync(CONFIG, 'utf8');
  for (const forbidden of ['password', 'secret', 'token', 'privateKey']) {
    assert.ok(
      !new RegExp(`export const \\w*${forbidden}`, 'i').test(committed),
      `env.config.js must not export anything like a ${forbidden}`
    );
  }
  // Only these two settings exist, so `.env` cannot become a place a credential
  // is quietly added.
  const exported = [...committed.matchAll(/export const (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exported, ['ADMIN_EMAIL', 'API_BASE']);
});
