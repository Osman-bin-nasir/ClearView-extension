/**
 * The backend client.
 *
 * Every call goes out from the service worker, never from a content script or a
 * UI page. That is not a style choice: the backend deliberately serves browsers
 * no CORS headers (its only client was the Android app, which sends no Origin),
 * and an extension page's fetch WOULD be refused. A request made by the service
 * worker to a host named in `host_permissions` is not subject to CORS, so this
 * is the one place from which the API is reachable — and keeping it here also
 * means no page ever holds an admin token.
 *
 * Nothing here retries blindly: a failed fetch returns a described failure, and
 * callers decide. In particular a failed rules refresh must leave the previous
 * snapshot in force (see rules-sync.js) rather than empty the blocklist.
 */

import { ADMIN, BRAINROT, coerceSubmissionSource, DEFAULT_API_BASE } from '../common/constants.js';
import { getAnonymousId } from '../common/settings.js';

/** An error carrying the backend's machine-readable `error` code. */
export class ApiError extends Error {
  constructor(code, status, message) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function join(base, path) {
  return `${(base || DEFAULT_API_BASE).replace(/\/+$/, '')}${path}`;
}

async function request(base, path, { method = 'GET', body, headers = {}, token, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(join(base, path), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    // Network failure or timeout — reported as a code the UI can word, never as
    // a thrown internal. "Could not reach the server. Nothing changed."
    throw new ApiError('network_unavailable', 0, error?.message);
  }
  clearTimeout(timer);

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const code = payload?.error ?? `http_${response.status}`;
    throw new ApiError(code, response.status, payload?.detail ?? payload?.error);
  }
  return payload;
}

// ── Public / anonymous surface ───────────────────────────────────────────

/**
 * Fetch the active global rule set.
 *
 * The returned `version` is a content fingerprint computed by the server, which
 * is what lets a refresh skip rewriting an unchanged list.
 */
export async function fetchRules(base) {
  const payload = await request(base, BRAINROT.rules);
  return {
    version: typeof payload?.version === 'string' ? payload.version : '',
    keywords: Array.isArray(payload?.keywords) ? payload.keywords : [],
    channels: Array.isArray(payload?.channels) ? payload.channels : [],
    fetchedAt: Date.now(),
  };
}

/** Suggest a keyword for the global repository. Inert until an admin approves. */
export async function submitSuggestion(base, { kind, value, note = null, source = null, displayName = null }) {
  const anonymousId = await getAnonymousId();
  return request(base, BRAINROT.suggestions, {
    method: 'POST',
    // `source` is coerced rather than passed through: the backend's schema is a
    // closed enum with a strict body, so any other value is a 400 rather than a
    // mislabelled record.
    body: { kind, value, note, source: coerceSubmissionSource(source), displayName, anonymousId },
  });
}

/** This device's own submissions and their current review status. */
export async function fetchSubmissions(base) {
  const anonymousId = await getAnonymousId();
  const payload = await request(base, `${BRAINROT.submissions}?anonymousId=${encodeURIComponent(anonymousId)}`);
  return Array.isArray(payload?.submissions) ? payload.submissions : [];
}

/** Report a false positive. Counted, never acted on automatically. */
export async function reportTarget(base, { kind, value, detail = null }) {
  const anonymousId = await getAnonymousId();
  return request(base, BRAINROT.reports, {
    method: 'POST',
    body: { kind, value, detail, anonymousId },
  });
}

// ── Admin surface ────────────────────────────────────────────────────────

export async function adminLogin(base, email, password) {
  return request(base, ADMIN.login, { method: 'POST', body: { email, password } });
}

export async function adminRefresh(base, refreshToken) {
  return request(base, ADMIN.refresh, { method: 'POST', body: { refreshToken } });
}

export async function adminLogout(base, refreshToken) {
  return request(base, ADMIN.logout, { method: 'POST', body: { refreshToken } });
}

/**
 * A raw admin call. [token] is supplied by the caller (the admin session), so
 * this module never reads or caches credentials itself.
 */
export async function adminRequest(base, path, { method = 'GET', body, token } = {}) {
  return request(base, path, { method, body, token });
}
