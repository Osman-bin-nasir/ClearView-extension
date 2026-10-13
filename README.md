# ClearView — Chrome Extension

A Chrome (Manifest V3) extension that brings the ClearView **Block tab** to the
browser. It is a browser-specific **interface to the existing ClearView
protection system**, not a replacement for it: it reuses the app's built-in
rules, its matching behaviour, and the deployed backend's community keyword
workflow.

- Blocks explicit websites and searches using the **same rules and the same
  matching engine** as the Android app.
- Hides the **YouTube Shorts** entry point **and** blocks Shorts links, matching
  the app's `blockShorts` control.
- **Brain Bot protection** on YouTube feeds, with a choice of *remove* or
  *overlay*.
- **Community keyword submissions** through the existing backend review queue,
  with **anonymous** contributor identity and a versioned, cached shared
  blocklist.
- A **protected admin dashboard** for reviewing, approving and rejecting
  submissions (server-enforced authorization).

---

## 1. Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's root folder (the one
   containing `manifest.json`).
4. Pin the extension from the puzzle-piece menu. Clicking the icon opens the
   popup; **Full settings** opens the complete Block tab.

No build step is required — the extension is plain ES modules and ships as-is.

**Requirements:** Chrome 102+ (for the `declarativeNetRequest` `extensionPath`
redirect), Node 20+ only if you want to run the tests or regenerate the rules.

---

## 2. Configure

Open **Full settings** (or `chrome://extensions` → *Extension options*).

| Setting | Purpose |
| --- | --- |
| **Protection** | Master switch. Off means nothing is blocked at all. |
| **Strict Mode** | Adds the app's discovery terms (bikini, lingerie, …). |
| **Block YouTube Shorts** | Hides the Shorts entry point and blocks Shorts links (app parity). |
| **Brain Bot Protection** | Filters YouTube feed cards. Choose *Remove from feed* or *Show protection overlay*. |
| **Blocked websites / keywords** | Your own rules. Keywords apply to every site and search. |
| **Brain Bot keywords** | Keywords matched against YouTube titles only. |
| **Blocked channels** | Stored by `@handle`, so a channel rename never loses the block. |
| **Backend server** | Defaults to the deployed ClearView server. Change for self-hosting. |
| **Anonymous identity** | The random install id your contributions are sent with. |

Everything is stored in `chrome.storage.sync` (settings) and
`chrome.storage.local` (caches, identity), so settings persist across browser
restarts and follow a signed-in Chrome profile.

---

## 3. How blocking works

Two mechanisms, chosen for what each is good at:

1. **`declarativeNetRequest`** for blocked **hosts** — one redirect rule per
   domain, registered dynamically (`src/background/blocking.js`,
   `installDomainRules`). The request is stopped before it loads.
2. **A navigation evaluator** (`evaluateUrl`, `chrome.webNavigation`) for
   anything needing real string work: keywords inside a URL, and the user's
   search query. These use the app's normalization and whole-word rules, which a
   DNR `urlFilter` cannot express.

**Search blocking** parses the query out of supported search-engine URLs (Google,
Bing, DuckDuckGo and YouTube — see `src/common/search-engines.js`), matches it
against the rules, and redirects a blocked search to
`https://www.google.com/webhp?safe=active`. The blocked query is **never** carried
into the redirect, and the redirect target is never itself blocked.

A blocked page is the extension's own `src/blocked/blocked.html`, and it is told
only a **reason code** — never the blocked URL or the matched term — so the
content the user is being protected from is not reprinted into the page or the
history.

### The matching engine

`src/common/matching.js` is a direct port of the Android `KeywordMatcher` and the
derived-set logic in `BlockRepository`: the same NFKC + homoglyph + leetspeak
normalization, the same whole-word boundary rule (`"cock"` does not match
`"cocktail"`, `"sex"` does not match `"middlesex"`), the same three tiers
(always-block, Strict-Mode, generic × risky combination). It is pure and
unit-tested, so the browser cannot drift from the phone.

### The built-in rules

`src/common/rules/*.js` are **generated** from the Android app's
`BlockRepository.kt`, so there is exactly one source of truth. To regenerate
after the app's lists change:

```bash
git clone https://github.com/muddassir-2025/ClearView.git ../ClearView
npm run rules                       # reads ../ClearView/.../BlockRepository.kt
# or point at any checkout:
node scripts/extract-builtin-rules.mjs path/to/BlockRepository.kt
```

The script strips Kotlin comments before parsing, so commented-out terms cannot
leak into the rule set.

---

## 4. YouTube behaviour

The content script (`src/content/youtube.js`) holds **no rules** and does no
matching: it reads what is on screen (card titles and channel names) and asks the
service worker which cards to act on. That keeps one matcher in the codebase —
the worker's — and keeps a page from holding the rule set.

- **Shorts:** two halves, deliberately split. The content script HIDES the entry
  points — it identifies them by *shape* (a link to `/shorts`) rather than by
  label, because YouTube relabels and re-renders far more often than it changes
  where a Shorts link points, and it re-applies on every DOM mutation so a guide
  rendered after load is still caught. The **worker** blocks a Shorts URL when the
  control is on (the `blockShorts` check in `evaluateUrl`), which is what stops a
  Short being reached by pasting its link.
- **Brain Bot:** cards are either removed (`display: none`) or covered in place
  by an overlay, per the chosen mode. YouTube is a single-page app, so changes are
  re-applied on `yt-navigate-finish` and on DOM mutations (debounced), and every
  card is marked once handled — an overlay can never be stacked twice.

---

## 5. Community keywords and the shared blocklist

User submissions reuse the **existing** backend workflow; the extension adds no
second system.

| Action | Endpoint |
| --- | --- |
| Fetch active global rules (+ content version) | `GET /api/v1/brainrot/rules` |
| Submit a keyword/channel for review | `POST /api/v1/brainrot/suggestions` |
| Read this install's submission statuses | `GET /api/v1/brainrot/submissions?anonymousId=…` |
| Report a false positive | `POST /api/v1/brainrot/reports` |

- **Anonymous identity.** A random UUID generated on install
  (`src/common/settings.js`) and sent as `anonymousId`. It is derived from
  nothing about the user. The client-supplied id is **not** treated as proof of
  anything: the server validates the shape, rate-limits the surface, and
  de-duplicates per device. Spam prevention is server-side.
- **Nothing unpublished applies to anyone.** A submission is inert until an
  administrator approves it; approval writes the rule and marks the submission in
  one backend transaction.
- **Caching and versioning** (`src/background/rules-sync.js`): the snapshot is
  cached in `chrome.storage.local` with the server's content-fingerprint
  `version`. A refresh that finds the same version only bumps the timestamp, and
  a **failed refresh leaves the previous snapshot in force** — protection can
  never be weakened by a dead backend. The TTL defaults to 6 hours, with a manual
  *Check for updates* and a periodic `chrome.alarms` refresh.
- **Built-in rules are never replaced by community rules** — they are merged on
  top (`src/common/rules-bundle.js`). An empty or unreachable shared list can only
  ever block *less*, never scramble the built-in protection.

---

## 6. Admin dashboard

Open it from the popup or the options page (`src/admin/admin.html`, also available
at `chrome://extensions` → *Extension options*… → *Admin dashboard*).

- Sign in with an **administrator email and password**.
- Tabs: **Overview** (review totals + most-requested targets), **Review queue**
  (approve / reject / mark under review), **Published rules** (enable, disable,
  remove), **False positives** (keep or remove the reported rule).

**Authorization is the server's, not the UI's.** Every route runs through the
backend's `requireAdmin`, which re-reads the administrator's row and its
permissions (`brainrot.read` / `brainrot.manage`, held by `super_admin` only) on
each request. Hiding a button here is a courtesy; forging a request from the
console is refused by the API.

The password is exchanged for a short-lived (10-minute) bearer token, which the
**service worker** holds and refreshes; the page never sees a credential it could
leak, and **no admin secret is bundled in the extension**.

### Creating the first administrator

Use the backend's own tooling (in the ClearView repository):

```bash
cd server
npm run create-admin       # or: npx tsx src/create-admin.ts
npx tsx scripts/check-super-admin.ts   # verify the account and its role
```

---

## 7. Backend integration and database

**No database changes are required.** The extension is a new client of the
existing `brainrot_*` tables and their migrations:

| Table | Role |
| --- | --- |
| `brainrot_devices` | Anonymous installs that have contributed. |
| `brainrot_keywords`, `brainrot_channels` | The **active** global rules (admin-written). |
| `brainrot_submissions` | User suggestions. Inert until approved. |
| `brainrot_reports` | Counted community signal + false-positive queue. |

Migrations: `014_brainrot.sql`, `015_brainrot_sources.sql`,
`017_brainrot_report_queue.sql`.

### A note on CORS

The backend deliberately serves browsers **no CORS headers** (its original only
client, the Android app, sends no `Origin`). Every request the extension makes
therefore goes through the **service worker**, whose request to a host in
`host_permissions` is exempt from CORS. Nothing is fetched from a content script
or a UI page. If you ever want to call the API from a web page instead, the
server would need `CORS_ORIGINS` set to include the extension origin — but the
current design avoids needing that at all.

### Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Settings, cached rules, stats, anonymous id. |
| `webNavigation` | To see a navigation's URL and redirect it before the page loads. |
| `declarativeNetRequest` | Dynamic host-blocking rules. |
| `alarms` | Periodic shared-blocklist refresh. |
| `host_permissions: https://clearview-1neb.onrender.com/*` | Reaching the API from the worker. |
| `optional_host_permissions: https://*/*` | Requested only if you point the extension at your own server. |

Content scripts are limited to `*://*.youtube.com/*`.

---

## 8. Testing

```bash
npm test        # node --test "tests/**/*.test.js"
```

48 tests, covering:

- **`tests/matching.test.js`** — normalization (fullwidth, leetspeak, separator
  and spaced forms), whole-word boundaries, domain matching, the three tiers, and
  that the combination tier never applies to URLs.
- **`tests/search-engines.test.js`** — Google/Bing/DuckDuckGo/YouTube parsing,
  query decoding, the safe destination carrying no query, and Shorts-URL
  detection.
- **`tests/rules.test.js`** — the generated lists are populated, no comment text
  leaked, and community rules **add** to the built-in ones.
- **`tests/blocking.test.js`** — the navigation evaluator and Brain Bot feed
  evaluation against stubs, including "protection off blocks nothing".
- **`tests/integration.test.js`** — the **real** ported rule set end-to-end
  (adult hosts, keyword-in-URL, explicit vs. normal searches, Strict Mode,
  community rules), plus a live check of the deployed backend's `/rules`
  contract, which skips automatically if the network is unavailable.

### Manual acceptance checklist

| Requirement | Where to verify |
| --- | --- |
| Explicit website blocked | Visit a blocked host → the ClearView blocked page. |
| Explicit search redirected, no query carried | Search an explicit term → lands on Google with no query in the URL. |
| Normal searches unaffected | Search anything ordinary. |
| Shorts entry point hidden **and** Shorts links blocked | Toggle on, reload YouTube, open a `/shorts/…` link. |
| Brain Bot remove / overlay | Toggle each mode on a home feed. |
| Dynamic navigation | Scroll the feed; overlays must not duplicate. |
| Settings persist | Restart Chrome. |
| Approved keywords distributed | Approve a submission in the dashboard, then *Check for updates*. |

---

## 9. Repository layout

```
manifest.json                 MV3 manifest
src/
  common/                     Pure, testable logic (no Chrome APIs)
    matching.js               Ported KeywordMatcher: normalization + tiers
    rules/                    GENERATED built-in rules (from BlockRepository.kt)
    rules-bundle.js           Effective rules = built-in + user + community
    search-engines.js         Search-URL parsing + safe destination
    constants.js              Storage keys, defaults, endpoints
    settings.js               chrome.storage access
  background/                 Service worker
    service-worker.js         Boot, message router, admin session
    blocking.js               DNR host rules + navigation evaluator
    rules-sync.js             Versioned/TTL shared-blocklist cache
    api.js                    Backend client (public + admin)
    state.js                  Live settings + rule bundle
  content/                    YouTube content script (Shorts, Brain Bot)
  popup/                      The Block tab, in miniature
  options/                    The full Block tab
  admin/                      Protected moderation dashboard
  blocked/                    Blocked destination page
  ui/                         Shared design system + helpers
scripts/
  extract-builtin-rules.mjs   Regenerate rules from the Android app
  make-icons.mjs              Generate the PNG icons (no dependencies)
tests/                        node --test suite
```

---

## 10. Privacy and security

- Websites and searches are checked **on the device** and are never uploaded.
  Only anonymous keyword *submissions* and *reports* leave the browser.
- The extension never collects or uploads browsing history.
- No privileged backend secret is bundled; the admin password is exchanged for a
  short-lived token held by the worker.
- Admin permissions are enforced **server-side**; the client is never trusted for
  authorization.
- A failed backend call degrades to the cached rules and never silently disables
  a protection that is switched on.

## 11. Known limitations

- **Shorts** hides the entry point *and* blocks Shorts URLs, at the request of
  the product owner and matching the Android app. The original brief asked for
  hide-only; the toggle's URL block is the single check in `evaluateUrl` and can
  be removed there to return to hide-only behaviour.
- The ported matcher covers URL, search-query and YouTube-feed surfaces. Android
  accessibility-only behaviours (incognito-browsing blocking, in-app WebView
  interception, device-admin and DNS controls) have no browser equivalent and are
  not part of the extension.
- Community keywords are distributed after a refresh (TTL 6 h, or on demand), so
  a newly approved rule may take up to that long to appear on a device that is
  not manually refreshed.
