# ClearView — Chrome Extension

A Chrome (Manifest V3) extension that brings the ClearView **Block tab** to the
browser. It is a browser-specific **interface to the existing ClearView
protection system**, not a replacement for it: it reuses the app's built-in
rules, its matching behaviour, and the deployed backend's community keyword
workflow.

- Blocks explicit websites and searches using the **same rules and the same
  matching engine** as the Android app.
- **Blocks YouTube ads** — the ad network requests are refused before they load,
  the ad slots are removed from the page, and a video ad that still starts is
  skipped (or run out) without touching the video you are watching. One toggle
  turns the whole thing off.
- **An optional Protection password.** After install the extension offers to set
  one, and once it is set, turning Protection on or off asks for it. It is a
device lock, not an account — see §12.
- Hides the **YouTube Shorts** entry point **and** blocks Shorts links, matching
  the app's `blockShorts` control.
- **Block a YouTube channel** from a video's ⋮ menu or by right-clicking a
  thumbnail. Its videos leave your feeds, and its channel page and videos will
  not open. Manage them in settings — remove one, or ask for a **global block**,
  with no account and no sign-in.
- **Brain Bot protection** on YouTube feeds, with a choice of *remove* or
  *overlay*.
- **Community keyword submissions** through the existing backend review queue,
  with **anonymous** contributor identity and a versioned, cached shared
  blocklist.
- A **protected admin dashboard** for reviewing, approving and rejecting
  submissions (server-enforced authorization).
- A **minimalist interface** — one accent, a neutral surface scale, generous
  spacing and a soft shadow, on the popup, the settings page and the dashboard.

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
| **Protection** | Master switch. Off means nothing is blocked at all. Gated by the password once one is set. |
| **Protection password** | Optional device lock. Set it to stop Protection being switched off in one click. |
| **Strict Mode** | Adds the app's discovery terms (bikini, lingerie, …). |
| **Block YouTube ads** | Refuses YouTube ad requests, removes ad slots, and skips video ads. On by default. |
| **Block YouTube Shorts** | Hides the Shorts entry point and blocks Shorts links (app parity). |
| **Brain Bot Protection** | Filters YouTube feed cards. Choose *Remove from feed* or *Show protection overlay*. |
| **Blocked websites / keywords** | Your own rules. Keywords apply to every site and search. |
| **Brain Bot keywords** | Keywords matched against YouTube titles only. |
| **Blocked channels** | Channels you blocked, with *Remove* and *Ask to block for everyone* on each. Stored by `@handle`, so a channel rename never loses the block. |
| **Backend server** | Defaults to the deployed ClearView server. Change for self-hosting. |
| **Anonymous identity** | The random install id your contributions are sent with. |

Everything is stored in `chrome.storage.sync` (settings) and
`chrome.storage.local` (caches, identity, and the Protection password hash — a
credential is not synced), so settings persist across browser restarts and
follow a signed-in Chrome profile.

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
3. **A static `declarativeNetRequest` ruleset** for YouTube ads (see §4.1),
   toggled on and off by the ad switch.

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

### YouTube ads

The ad blocker follows the model every YouTube ad blocker uses — refuse the ad
where it is fetched, remove it where it still appears — and adds the one thing a
network filter cannot do on its own: get rid of the ad that YouTube serves from
its own origin.

Three layers, each covering what the one before it cannot:

1. **Ad requests are refused** by a static `declarativeNetRequest` ruleset
   (`src/background/rules/youtube-ads.json`, ruleset id `youtube_ads`). This is
   the AdBlock-for-YouTube approach: the ad never arrives, so nothing has to be
   hidden afterwards. The rules are in a FILE, not in JS, and every rule is
   scoped with `initiatorDomains: youtube.com…` — so the same ad network is left
   alone on unrelated sites, and no top-level navigation is ever blocked.
2. **Ad slots are removed from the page** by the content script. The stylesheet
   hides every known ad container under `html.cv-block-ads` (instant, and
   independent of the script's timing), and the script then takes the in-feed
   ads out of the DOM *with their grid wrapper* — because a hidden grid item
   keeps its cell and leaves a hole in the feed. Removed nodes are remembered, so
   the switch is reversible.
3. **A video ad that still starts is skipped.** YouTube's own skip control is
   clicked the moment it exists; an overlay/banner ad is dismissed by its close
   button; and an unskippable ad is fast-forwarded to its end. The pass runs on a
   one-second heartbeat as well as on DOM mutations, because an ad is announced
   by a *class* change on the player, which fires no mutation — a pass driven by
   the observer alone would routinely miss it.

The mute that the unskippable path applies is recorded on the element and undone
the moment the ad ends, so the video the user came to watch is never left silent.

The toggle (`blockYoutubeAds`) follows the same rule as the other content
controls: it is inert while **Protection** is off, and the ruleset is enabled by
the worker (`installAdRules`) rather than by a page.

### Blocking a channel

Two ways in, both from where the user already is:

- **A video's own ⋮ menu.** A *Block this channel* entry is added to the watch
  page's overflow menu. When the channel is already blocked the entry reads
  *Unblock this channel* instead, so it can never be a button that does nothing
the user expects.
- **Right-click.** *Block this channel (ClearView)* appears on a thumbnail, the
  player, or a channel name.

**What a block does** (Feeds + the channel's own pages):

| Surface | How it is decided |
| --- | --- |
| YouTube feeds | The card's channel **link** (`/@handle` or `/channel/UC…`) is matched, not its printed name. Filtered whenever Protection is on — the Brain Bot toggle governs the *keyword* filters, and an explicit block is not its business. |
| The channel's page and its tabs (`/videos`, `/shorts`, …) | The identity is in the URL, so the worker's navigation evaluator blocks it — `/@handle`, `/channel/UC…`, `/c/Name` and `/user/Name` all resolve to the same channel. |
| A video page | A watch URL names **no channel**, so the content script reads the owner link off the page and asks the worker (`channel/check`). The redirect is the worker's, because a page cannot navigate itself to a `chrome-extension://` URL — which is also why the blocked page is *not* made web-accessible. |

An explicitly blocked channel is **removed** from feeds whatever the Brain Bot
display mode is: the mode chooses how a keyword match is presented, and has no
business leaving behind a channel the user asked to be rid of.

### Channel identity, and what is never guessed

A channel is identified by three things YouTube will name it by — `/@handle`,
`/channel/UC…`, and the legacy `/c/` and `/user/` forms — all parsed in
`src/common/channels.js`. Both the **handle** and the **channel id** are stored
when both are known: a handle can be renamed away and an id cannot, and the
reverse holds for a block made before the id was ever seen.

Matching may fall back to a channel's **display name**, because a feed card is
sometimes all there is. **Storing a block may not.** A handle invented from a
display name — `"Some Channel • Music"` → `@somechannelmusic` — would be written
to storage and would then block a channel the user never chose, or nothing at
all, silently. So a block with nothing but a name is *refused* with a message
pointing at the ⋮ menu, rather than accepted.

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
- **No account, and no sign-in.** A blocked channel can be sent for global
  review without any account, exactly as the Android app does it. There is no
  Google/Firebase sign-in in the extension.
- **`source` is a closed enum.** The server accepts `youtube_not_interested`,
  `app` or `unknown` and its body schema is `.strict()`, so any other value is
  refused outright — not recorded as "unknown". The client coerces to that list
  (`SUBMISSION_SOURCES` in `src/common/constants.js`) rather than passing a
  value of its own invention.
- **A global channel request needs a `@handle`.** The server stores a channel
  rule as a handle and refuses anything else, so a channel known only by its
  opaque id shows *Remove* but not *Ask to block for everyone*.
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

**The administrator's email lives in `.env`**, and is used for exactly one thing:
pre-filling the sign-in form.

```bash
cp .env.example .env      # set ADMIN_EMAIL=you@example.com
npm run config            # bakes .env into src/common/env.config.js
```

The extension has no runtime environment — nothing inside one can read `.env` —
so `npm run config` writes those values into a module it imports. The defaults
are committed, so **the extension loads and works without ever running it**.

What is *not* in that value is any authority. It grants nothing: the backend
re-reads the administrator's row and its permissions on every request, so typing
a different address changes no permission, and a fabricated request from the
console is refused by the API. There is deliberately no password, token or
service-account key in `.env.example`, and none belongs there — a credential
shipped inside an extension is a credential published to everyone who installs
it. For the same reason there is **no Google/Firebase sign-in**: the app's
Firebase *Auth* project would require an OAuth client for this extension and
would add an identity the backend's anonymous submission surface does not ask
for.

### Creating the first administrator

The administrator is a **backend** concept, not an extension one — it lives in
the backend's own `.env` and database, in the ClearView repository:

```bash
cd server
npm run create-admin       # or: npx tsx src/create-admin.ts
npx tsx scripts/check-super-admin.ts   # verify the account and its role
```

The account needs the `brainrot.read` / `brainrot.manage` permissions to see the
review queue; those are held by `super_admin` only, and they are what the
dashboard's tabs are gated on — server-side, per request.

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
| `storage` | Settings, cached rules, stats, anonymous id, and the local password hash. |
| `webNavigation` | To see a navigation's URL and redirect it before the page loads. |
| `declarativeNetRequest` | Dynamic host-blocking rules, and the static YouTube ad ruleset. |
| `alarms` | Periodic shared-blocklist refresh. |
| `contextMenus` | The right-click *Block this channel* entry. |
| `host_permissions: https://clearview-1neb.onrender.com/*` | Reaching the API from the worker. |
| `optional_host_permissions: https://*/*` | Requested only if you point the extension at your own server. |

Content scripts are limited to `*://*.youtube.com/*`.

The ad ruleset is declared in `declarative_net_request.rule_resources` with
`"enabled": false`, so it costs nothing until the ad switch turns it on and
nothing at all once Protection is off.

---

## 8. Testing

```bash
npm test        # node --test "tests/**/*.test.js"
```

177 tests, covering:

- **`tests/matching.test.js`** — normalization (fullwidth, leetspeak, separator
  and spaced forms), whole-word boundaries, domain matching, the three tiers, and
  that the combination tier never applies to URLs.
- **`tests/search-engines.test.js`** — Google/Bing/DuckDuckGo/YouTube parsing,
  query decoding, the safe destination carrying no query, and Shorts-URL
  detection.
- **`tests/rules.test.js`** — the generated lists are populated, no comment text
  leaked, and community rules **add** to the built-in ones.
- **`tests/blocking.test.js`** — the navigation evaluator and Brain Bot feed
  evaluation against stubs, including "protection off blocks nothing" and the
  blocked-channel rules (a channel page in every URL shape it has, a feed card
  matched through its link, and that a **video** URL is deliberately *not*
  decided from the URL alone).
- **`tests/channels.test.js`** — channel identity: URL shapes, relative hrefs,
  handle/id normalization, block-list de-duplication, add/remove, and matching by
  handle, by id and by display name.
- **`tests/channel-menu.test.js`** — resolving a right-click (including the
  refusal to block a channel for a link that is not on YouTube), the submission
  **source enum**, and static guards on the ⋮-menu injection (scoped to the watch
  page's own menu, plain DOM rather than YouTube's managed elements, injected
  once).
- **`tests/config.test.js`** — the `.env` → `env.config.js` generator, run for
  real and imported, plus the check that no credential is ever added to it.
- **`tests/integration.test.js`** — the **real** ported rule set end-to-end
  (adult hosts, keyword-in-URL, explicit vs. normal searches, Strict Mode,
  community rules), plus a live check of the deployed backend's `/rules`
  contract, which skips automatically if the network is unavailable.
- **`tests/ads.test.js`** — the ad blocker's seams: the manifest ruleset exists
  and starts disabled, every rule blocks and is scoped to YouTube (and never to
  `main_frame`), the ad networks that actually serve YouTube are covered, the
  worker enables the ruleset from the setting under the master switch, the
  content pass removes AND restores, the skip/fast-forward/mute paths are
  present, and the Protection change is gated in the worker rather than the UI.
- **`tests/password.test.js`** — the local password: no plaintext is ever
  stored, the right password verifies and the wrong one does not, the same
  password hashes differently on every write (per-install salt), replacing it
  invalidates the old one, and length is counted in code points.
- **`tests/password-gate.test.js`** — the **real** worker, driven by message:
  the ad ruleset is switched on at boot, follows the ad switch under the master
  one, and is disabled when Protection goes off; and changing Protection is
  refused without the password, refused with the wrong one, and applied with the
  right one — while every other setting stays free.
- **`tests/ui-render.test.js`** — the popup and the settings page rendered for
  real against a small DOM shim: the hero, the ad toggle, the first-run password
  offer, the password card, and the dialog's mismatch/cancel/retry behaviour.

### Manual acceptance checklist

| Requirement | Where to verify |
| --- | --- |
| Explicit website blocked | Visit a blocked host → the ClearView blocked page. |
| Explicit search redirected, no query carried | Search an explicit term → lands on Google with no query in the URL. |
| Normal searches unaffected | Search anything ordinary. |
| Shorts entry point hidden **and** Shorts links blocked | Toggle on, reload YouTube, open a `/shorts/…` link. |
| **YouTube ads blocked** | With the toggle on, reload YouTube: no pre-roll, no feed/sidebar ad slots, no banner. Turn it off and the ad slots return on the next reload. |
| **First-run password offer** | On a fresh install the settings page offers to set a password; skipping it does not ask again. |
| **Protection gated by the password** | With a password set, flip Protection on the popup — it asks for the password, and a wrong one changes nothing. |
| Brain Bot remove / overlay | Toggle each mode on a home feed. |
| Dynamic navigation | Scroll the feed; overlays must not duplicate. |
| **Block a channel from ⋮** | Open a video, use the ⋮ menu → *Block this channel*; the entry then reads *Unblock this channel*. |
| **Block a channel by right-click** | Right-click a thumbnail → *Block this channel (ClearView)*. |
| **A blocked channel is gone** | Its cards leave home/search/subscriptions, `/@handle` and `/channel/UC…` show the blocked page, and its video pages redirect there. |
| **Right-click off-target is refused** | Right-click a link in a video description → a message, and no block. |
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
    channels.js               Channel identity: URL parsing + block-list matching
    search-engines.js         Search-URL parsing + safe destination
    constants.js              Storage keys, defaults, endpoints, source enum
    settings.js               chrome.storage access
    password.js               The local Protection password: hash, verify, store
    env.config.js             GENERATED from .env by `npm run config`
  background/                 Service worker
    service-worker.js         Boot, message router, admin session, password gate
    blocking.js               DNR host rules + ad ruleset + navigation evaluator
    rules/youtube-ads.json    Static DNR ruleset: the YouTube ad networks
    context-menus.js          The right-click "Block this channel" entry
    rules-sync.js             Versioned/TTL shared-blocklist cache
    api.js                    Backend client (public + admin)
    state.js                  Live settings + rule bundle
  content/                    YouTube content script (Shorts, Brain Bot)
  popup/                      The Block tab, in miniature
  options/                    The full Block tab
  admin/                      Protected moderation dashboard
  blocked/                    Blocked destination page
  ui/                         Shared design system + helpers
    theme.css                 The minimalist design system (light + dark)
    shared.js                 DOM builder, cards, hero, toast
    password.js               The password dialog and first-run offer
scripts/
  extract-builtin-rules.mjs   Regenerate rules from the Android app
  make-icons.mjs              Generate the PNG icons (no dependencies)
  make-config.mjs             Turn .env into src/common/env.config.js
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
- The Protection password is stored as a salted PBKDF2-SHA256 hash on the device
  only. No password, secret or service-account key is bundled in the extension.
- A failed backend call degrades to the cached rules and never silently disables
  a protection that is switched on.

## 11. Known limitations

- **The ⋮ menu entry is injected, not sanctioned by YouTube.** It is added to the
  watch page's own overflow menu by the content script, scoped to
  `ytd-watch-metadata` so it cannot land in another menu, and built from plain DOM
  rather than YouTube's Polymer-managed menu elements (which would upgrade and
  could discard it). YouTube can still change that markup; if the entry stops
  appearing, the right-click menu and the settings page are unaffected. No
  in-browser automation is available here, so this is the part most worth
  checking by hand — see the manual checklist in §8.
- **A blocked channel's video pages redirect away.** That is the requested
  behaviour ("feeds + the channel's own pages"), but be aware it acts on the
  *video* too, not only the channel page: a video URL names no channel, so the
  content script reads the owner off the page and the worker redirects. Turning
  Protection off stops it immediately.
- **Shorts** hides the entry point *and* blocks Shorts URLs, at the request of
  the product owner and matching the Android app. The original brief asked for
  hide-only; the toggle's URL block is the single check in `evaluateUrl` and can
  be removed there to return to hide-only behaviour.
- The ported matcher covers URL, search-query and YouTube-feed surfaces. Android
  accessibility-only behaviours (incognito-browsing blocking, in-app WebView
  interception, device-admin and DNS controls) have no browser equivalent and are
  not part of the extension.
- **Ad blocking is a moving target.** YouTube changes its ad delivery often, so
  the ruleset and the ad selectors will need updating from time to time. The
  three layers degrade independently — losing the selectors still leaves the
  network rules working — and the toggle is the honest off switch when a change
  breaks something.
- **A YouTube ad can still flash for a moment.** The ruleset and the stylesheet
  are what prevent that, but an ad served from YouTube's own origin can render a
  frame before the content pass acts. Skipping is reactive by nature.
- **The password is a device lock.** It is not authentication, and it does not
  survive clearing the extension's data — see §12.
- Community keywords are distributed after a refresh (TTL 6 h, or on demand), so
  a newly approved rule may take up to that long to appear on a device that is
  not manually refreshed.
- The removed YouTube ad nodes are restored when the toggle is turned off, but
  the page is a single-page app: a slot YouTube re-rendered after the toggle
  changed comes back only on the next navigation.

---

## 12. The Protection password

An optional lock on the **Protection** switch, offered once after install
(`src/common/password.js`, `src/ui/password.js`).

- **What it guards.** Turning Protection on or off, from any screen. The check
  is in the service worker's `settings/update` — the one path every change goes
  through — so it cannot be bypassed by a page that skips the dialog.
- **What it is not.** A device lock, not an account and not authentication. It
  stops a one-click change on a shared or borrowed machine. It cannot hide
  anything from someone with full access to the browser profile, and the UI says
  so rather than implying otherwise.
- **How it is stored.** Never the password itself: a random 16-byte salt and a
  PBKDF2-SHA256 hash (120,000 iterations), written to `chrome.storage.local`.
  Local and not synced, because a credential has no business travelling to
  another machine with the settings. Verification is a constant-time comparison,
  and every failure returns the same answer.
- **Creating, changing and removing it.** Offered in the settings page's
  *Security* section and as a first-run offer. Changing or removing it requires
  the current password, so the lock cannot remove itself; forgetting it means
  clearing the extension's storage, which is stated plainly rather than dressed
  up as a recovery flow.
