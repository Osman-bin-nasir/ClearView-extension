# ClearView — Chrome Extension

A Chrome (Manifest V3) extension that brings the ClearView **Block tab** to the
browser. It is a browser-specific **interface to the existing ClearView
protection system**, not a replacement for it: it reuses the app's built-in
rules, its matching behaviour, and the deployed backend's community keyword
workflow.

- Blocks explicit websites and searches using the **same rules and the same
  matching engine** as the Android app.
- Hides **YouTube Shorts** — the sidebar and mini-guide entry points, the chip
  above the feed, the Shorts shelf and its individual cards, and the channel
  page's Shorts tab — **and** blocks Shorts links, matching the app's
  `blockShorts` control.
- **Block a YouTube channel** from a video's ⋮ menu or by right-clicking a
  thumbnail — no need to open the video first. Its videos leave your feeds, its
  search result disappears, and its channel page and videos will
  not open. Manage them in settings — remove one, or ask for a **global block**,
  with no account and no sign-in.
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
| **Block YouTube Shorts** | Hides the Shorts entry points, the feed shelf and its cards, and blocks Shorts links (app parity). |
| **Brain Bot Protection** | Filters YouTube feed cards. Choose *Remove from feed* or *Show protection overlay*. |
| **Blocked websites / keywords** | Your own rules. Keywords apply to every site and search. |
| **Brain Bot keywords** | Keywords matched against YouTube titles only. |
| **Blocked channels** | Channels you blocked, with *Remove* and *Ask to block for everyone* on each. Stored by `@handle` and by channel id where they are known, so a rename never loses the block; a block made from a feed card that carries no link is stored and matched by the channel's printed name, and says so. |
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

   It is registered for **both** of the API's navigation events, and the second
   one is not a detail. `onBeforeNavigate` is a navigation that replaces the
   document; `onHistoryStateUpdated` is one that does not — the page rewrote the
   address itself with `history.pushState`. Modern sites search that way: typing
   in YouTube's own search box never leaves the document, so it fires no
   navigation event at all, and a listener that only knew `onBeforeNavigate`
   never saw the query. The URL was right and the rules matched — nothing ever
   asked. Both events carry the same details shape and go through the same
   evaluation, so there is no second copy of the logic to drift.

**Search blocking** parses the query out of a search URL and matches it against
the rules, then redirects a blocked search away from it. Where it lands depends
on where the search was made: a search made **on YouTube** goes back to
`https://www.youtube.com/`, and every other site keeps
`https://www.google.com/webhp?safe=active`. The user was on YouTube and searched
there, so emptying them out onto Google answers a question they did not ask. The
blocked query is **never** carried into either redirect, and neither redirect
target is itself blocked.

The query is read on **every site**, not only on Google, Bing, DuckDuckGo and
YouTube (`src/common/search-engines.js`). Those four were once the whole feature,
and the gap they left was the phrase tier: a typed query is judged by the full
rules — where “woman” plus “bikini” blocks although neither half blocks alone —
while a URL is judged by the weaker URL rules, which deliberately skip that tier
so `/photos/beach.html` cannot trip it. Only the four engines' queries reached
the phrase tier, so the *same phrase* was blocked on Google and passed on a
Reddit or Amazon search. One technique, so it now applies wherever the query is
typed.

Two guards keep that from turning ordinary pages into blocks, and both are
tested: a query is only read out of a parameter that **means** search (`q`,
`query`, `search_query`, `k`, `s`, `_nkw`, …), and a value that is an **address**
rather than a query (a redirector's `?q=https://…`) is left for the URL check to
judge on its own terms. A host with rules of its own is never second-guessed by
the generic scan, which is what keeps `google.com/url?q=…` and
`youtube.com/watch?v=…&q=…` out of it.

A blocked page is the extension's own `src/blocked/blocked.html`, and it is told
only a **reason code** — never the blocked URL or the matched term — so the
content the user is being protected from is not reprinted into the page or the
history.

The page asks the user for nothing: it carries no buttons, and no wording telling
them to “go back” or to open settings. The way out is the browser's own **Back**,
and it works — the page pushes a same-document history entry of its own, so Back
is a traversal the page can answer, and it answers it by going to **YouTube's home
page** rather than re-requesting the address that was blocked. Without that, the
entry behind the blocked page is the blocked address itself: Back re-requests it,
the worker blocks it again, and the user is returned to the blocked page — a Back
button that looks like it does nothing.

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

- **Shorts:** two halves, deliberately split. The content script HIDES everything
  Shorts-shaped, and it identifies each surface by *shape* rather than by label:
  the entry points by a link to `/shorts` (YouTube relabels and re-renders far
  more often than it changes where a Shorts link points), and the content by what
  it is — the shelf (`ytd-rich-shelf-renderer[is-shorts]`, `ytd-reel-shelf-renderer`),
  the card (`ytm-shorts-lockup-view-model`), the badge that marks a Short in an
  ordinary list (`overlay-style="SHORTS"`), and the channel page's Shorts tab.
  Hiding the entry point alone left the Shorts still playing in the feed, which
  is not what "no Shorts" means. It re-applies on every DOM mutation, so a shelf
  or guide rendered after load is still caught. The **worker** blocks a Shorts URL
  when the control is on (the `blockShorts` check in `evaluateUrl`), which is what
  stops a Short being reached by pasting its link.

  The same shapes are in **both** halves of the hiding: `src/content/youtube.css`
  (an instant hide, through `:has()`) and the content script's own pass (the
  safety net for Chrome 102–104, which has no `:has()`, and for the chip, whose
  markup names itself in no attribute and can only be recognised by its text).
- **Brain Bot:** cards are either removed (`display: none`) or covered in place
  by an overlay, per the chosen mode. YouTube is a single-page app, so changes are
  re-applied on `yt-navigate-finish` and on DOM mutations (debounced), and every
  card is marked once handled — an overlay can never be stacked twice.
- **Feed cards are read as they actually are, not as they were.** A card's title
  and channel are read from *both* card markups in the wild: the classic
  `#video-title` / `ytd-channel-name` renderer, and the current
  `yt-lockup-view-model` grid, whose title is a class-carrying anchor inside an
  `<h3>` and whose channel is a metadata row with **no link at all** (see below).
  Reading only the classic markup is why a title filter and a feed-wide channel
  block could both look switched off while doing nothing.
- **A decision is stamped with the rules it was made under.** Each card records
  the worker's opaque rules fingerprint, and a card is judged again whenever that
  fingerprint changes. YouTube caches and re-attaches whole feed subtrees, so a
  card judged clean before a channel was blocked would otherwise come back on
  screen with nothing to re-check it — which is exactly what "I blocked it but it
  is still in my feed" was.

### Blocking a channel

Three ways in, all from where the user already is — and none needs the video
opened first:

- **A card's own ⋮.** Every thumbnail on a feed, a search result and a channel's
grid is already showing a three-dot button; *Block channel* is added to the menu
it opens, first in the list. No video, no player, no page change. Two different
menus are live under that button and both are handled — the current grid's card
opens a context **sheet** (`yt-sheet-view-model` with a list of
`yt-list-item-view-model` rows), while a **search** result opens the classic
`ytd-menu-popup-renderer` list. The entry acts on the card's own channel, and
falls back to the page's (`/watch`, a channel page) when the card names nobody —
which is every card on a channel's own grid.

  A card also comes in **two container shapes**, and both are recognised. The
  renderers (`ytd-rich-item-renderer` and friends) wrap the modern card, but the
  channel home tab — and the home feed on accounts YouTube serves the bare grid
  to — renders `yt-lockup-view-model` at the top level with **no renderer around
  it**. Recognising only the renderers produced two symptoms from one cause, both
  reported as "it does nothing": the ⋮ click had no card to record, so the menu
got no entry at all and nothing could be clicked or confirmed; and the card was
  never scanned, so a channel blocked anywhere else kept showing. One lockup is
evaluated once — a lockup nested inside a renderer is already covered by it.
- **Right-click.** *Block this channel (ClearView)* appears on a thumbnail, the
  player, or a channel name. A thumbnail links to a *video*, which names no
  channel, so the content script reports which card was clicked and the worker
  blocks what that card actually offers: the channel's link on the classic
  renderer, and the channel's **printed name** on the current grid, which has no
  link to offer. On a channel's own page the address bar answers it alone.
- **A video's own ⋮ menu.** A *Block this channel* entry is added to the watch
  page's overflow menu — first in the list, because the menu scrolls when it is
  long and an entry at the bottom is one the user has to hunt for. When the
  channel is already blocked the entry reads *Unblock this channel* instead, so
  it can never be a button that does nothing the user expects.

**What a block does** (Feeds + the channel's own pages):

| Surface | How it is decided |
| --- | --- |
| YouTube feeds | The card's channel **link** (`/@handle` or `/channel/UC…`) is matched when the card has one, and the channel's **printed name** when it does not — which is every card in the current `yt-lockup-view-model` grid, where the channel is an attributed string carrying a click command and no href. Filtered whenever Protection is on — the Brain Bot toggle governs the *keyword* filters, and an explicit block is not its business. |
| A search result | A search for a channel's name returns a `ytd-channel-renderer` — the big avatar and a Subscribe button — and it is evaluated like any other card, so a blocked channel's does not appear at all. |
| The channel's page and its tabs (`/videos`, `/shorts`, …) | The identity is in the URL, so the worker's navigation evaluator blocks it — `/@handle`, `/channel/UC…`, `/c/Name` and `/user/Name` all resolve to the same channel. The content script also sends the name the page prints, which is what covers a block stored by name alone. |
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

Matching falls back to a channel's **display name**, and on the current grid that
is the normal path rather than the exception: the channel on such a card is an
attributed string with a click command and no href, so the printed name is all
the card gives. A block is stored by `@handle` *and* by the display name seen at
block time, and a card matches on either — comparing names to names, because a
handle derived from a name (`"The Japanese Town"` → `@thejapanesetown`) is not
that channel's real handle (`@TheJapaneseTown-jt6fy`).

**A name is stored as a name, never invented into a handle.** `"Some Channel •
Music"` → `@somechannelmusic` is a value the user never chose that matches
nothing, so it is never written: the handle and the id come from a URL and
nothing else, and a display name goes into the record's `name` field. That is
the whole reason a right-click on the current grid works at all — there is
nothing else on the card to record — and it is also the one identity weaker than
a handle, since two channels can print the same name. Every surface that offers
a handle or an id is matched by it first, and a global (community) request still
requires a `@handle`, because the server stores rules by handle.

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
  nothing about the user. It is written **once and never replaced**: settings
  shows it read-only, and there is no regenerate path in the worker either, so
  nothing can silently split one install's contributions into two sets of
  records server-side. The client-supplied id is **not** treated as proof of
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
- **There is no sign-up, and none is missing.** The form is a sign-in only: an
  administrator exists because a row was created for one on the backend, and
  `POST /admin/api/auth/login` answers `401 invalid_credentials` for anything
  else. The page says so on a refusal, because "invalid credentials" from a form
  with no "create account" next to it reads like a broken button.
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
pre-filling the sign-in form. It has to be **exactly** the backend's
`SUPER_ADMIN_EMAIL`: the server finds the account by address, so a near-miss is
`401 invalid credentials` for every correct password — the one refusal that looks
like a wrong password but is a wrong address.

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

**The password comes from the SERVER's environment**, not from the extension's
`.env`: `SUPER_ADMIN_EMAIL` with `SUPER_ADMIN_PASSWORD_HASH` (bcrypt) or
`SUPER_ADMIN_PASSWORD`, which the backend hashes at boot. The server reconciles
that plaintext on **every** boot — if it no longer opens the account, the stored
hash is replaced with it — so a deployment whose env still holds the old value is
exactly what answers every sign-in with `invalid credentials`. Recover with
`npm run create-admin -- --reset --password <new>`, or change the value in the
host's dashboard and let the next boot reconcile it. `ADMIN_EMAIL` in the
extension's `.env` is only the form pre-fill, and changing it grants nothing.

**A deployment configured with only `SUPER_ADMIN_PASSWORD_HASH` has no
recoverable password.** The boot reports `already_provisioned` and never compares
the hash with anything — it cannot: a digest is one-way, so there is no plaintext
to test. If nobody remembers the value that produced it, set
`SUPER_ADMIN_PASSWORD` (a real one — `replace-with`, `changeme`, `change-me`,
`your-`, `placeholder` and `xxx` prefixes are refused as placeholders), restart,
and the next boot hashes it over the stale hash. To check a password you think you
remember, without touching the deployment:

```bash
cd server && npm install   # the sync dependency the server already uses
node --input-type=module -e 'import b from "bcryptjs"; console.log(b.compareSync(process.argv[1], process.argv[2]))' \
  '<candidate>' '<SUPER_ADMIN_PASSWORD_HASH from the host>'
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
| `storage` | Settings, cached rules, stats, anonymous id. |
| `webNavigation` | To see a navigation's URL — a page load AND a same-document `pushState` — and redirect it. |
| `declarativeNetRequest` | Dynamic host-blocking rules. |
| `alarms` | Periodic shared-blocklist refresh. |
| `contextMenus` | The right-click *Block this channel* entry. |
| `host_permissions: https://clearview-1neb.onrender.com/*` | Reaching the API from the worker. |
| `optional_host_permissions: https://*/*` | Requested only if you point the extension at your own server. |

Content scripts are limited to `*://*.youtube.com/*`.

---

## 8. Testing

```bash
npm test        # node --test "tests/**/*.test.js"
```

158 tests, covering:

- **`tests/matching.test.js`** — normalization (fullwidth, leetspeak, separator
  and spaced forms), whole-word boundaries, domain matching, the three tiers, and
  that the combination tier never applies to URLs.
- **`tests/search-engines.test.js`** — Google/Bing/DuckDuckGo/YouTube parsing,
  the generic scan on any other site, the two guards that keep it off ordinary
  pages (a non-search parameter, and a query value that is an address), query
  decoding, the safe destination carrying no query, and Shorts-URL detection.
- **`tests/rules.test.js`** — the generated lists are populated, no comment text
  leaked, and community rules **add** to the built-in ones.
- **`tests/blocking.test.js`** — the navigation evaluator and Brain Bot feed
  evaluation against stubs, including "protection off blocks nothing" and the
  blocked-channel rules (a channel page in every URL shape it has, a feed card
  matched through its link, and that a **video** URL is deliberately *not*
  decided from the URL alone).
- **`tests/channels.test.js`** — channel identity: URL shapes, relative hrefs,
  handle/id normalization, block-list de-duplication, add/remove, and matching by
  handle, by id and by display name. Includes the name-only record: a block made
  from a card that carries no link is stored as a NAME, is labelled by it, and
  collapses with a second block of the same name.
- **`tests/channel-menu.test.js`** — resolving a right-click into a *target* (a
  URL, a name, or both) rather than a guessed identity: a channel link, a card's
  channel read off the page, a card that offers only a NAME, a link that is not
  on YouTube (refused), and a page's own URL as the last resort. Plus the
  submission **source enum**, the rule that a display name is never promoted to a
  stored handle, and static guards on the ⋮-menu injection (scoped to the watch
  page's own menu, plain DOM rather than YouTube's managed elements, injected
  once, and placed first so a scrolling menu cannot hide it).
- **`tests/context-menu-flow.test.js`** — the right-click flow end to end, with
  the real worker against a stubbed `chrome`: what is written to storage for a
  channel link, for a card that gives only a name, and for a target with nothing
  in it (refused).
- **`tests/content-shorts.test.js`** — static guards on the shipped Shorts
  artefacts: the `/shorts` link is matched by **prefix**, the label is matched on
  the element *and* on a descendant, the feed shelf / reel shelf / Short card /
  Shorts tab are all covered by the stylesheet *and* the script, and the hiding
  is reversible.
- **`tests/feed-cards.test.js`** — static guards on how a feed card is read and
  remembered: the current grid's title is read as well as the classic
  `#video-title`, a card with no channel link falls back to its printed name (and
  a views row is never mistaken for one), a channel RESULT in a search is a card
  like any other (and the name-bearing link wins over the avatar link), the
  worker's rules fingerprint is what makes a past verdict stale, the ⋮ menu entry
  is placed where a long menu cannot hide it, a channel page is checked by name
  as well as by URL, and a removal is not undone by its own cleanup.
- **`tests/config.test.js`** — the `.env` → `env.config.js` generator, run for
  real and imported, plus the check that no credential is ever added to it.
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
| Shorts gone: entry points, feed shelf, Shorts cards, channel tab | Toggle on, reload YouTube, scroll the home feed, open a channel page, open a `/shorts/…` link (blocked). |
| Brain Bot remove / overlay | Toggle each mode on a home feed. |
| Dynamic navigation | Scroll the feed; overlays must not duplicate. |
| **Block a channel from ⋮** | Open a video, use the ⋮ menu → *Block this channel*; the entry then reads *Unblock this channel*. |
| **Block a channel by right-click** | Right-click a thumbnail → *Block this channel (ClearView)*. On the current grid the card carries no channel link: the block is then recorded by name, and the toast says which name. |
| **A blocked channel’s search result is gone** | Search the channel's name: no avatar result, no Subscribe button, for it — and other channels' results are untouched. |
| **A blocked channel is gone** | Its cards leave home/search/subscriptions (both card markups — the `yt-lockup-view-model` grid and the classic list), `/@handle` and `/channel/UC…` show the blocked page, and its video pages redirect there. |
| **A block made on a video page reaches the feed** | Block from a video's ⋮ menu, go back to the feed, scroll: no card from that channel, including ones already on screen. |
| **Brain Bot overlay is visible** | Switch to *Show protection overlay* with a keyword that matches: the card stays and is covered by the ClearView overlay, and switch to *Remove* and the same card leaves. |
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
    search-engines.js         Search-URL parsing (any site) + safe destination
    constants.js              Storage keys, defaults, endpoints, source enum
    settings.js               chrome.storage access
    env.config.js             GENERATED from .env by `npm run config`
  background/                 Service worker
    service-worker.js         Boot, message router, admin session
    blocking.js               DNR host rules + navigation evaluator
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
- **Shorts** hides every Shorts surface *and* blocks Shorts URLs, at the request
  of the product owner and matching the Android app. The original brief asked for
  hide-only; the toggle's URL block is the single check in `evaluateUrl` and can
  be removed there to return to hide-only behaviour. Hiding is by shape, so a
  surface YouTube has not shipped yet (a new shelf element) is not hidden until
  it is added to `SHORTS_CANDIDATE_SELECTOR` and the stylesheet — the chip and the
  Shorts tab are the two that are recognised by their label, so they are the ones
  a localised or renamed label could defeat.
- **A channel blocked by name can catch a namesake.** On cards that expose no
  channel link, matching is by the printed name, and two channels can print the
  same one. The handle and the id are checked first wherever a surface offers
  them, so this only ever applies where the name is the sole signal.
- **A name-only block cannot be submitted for everyone.** A global request needs
  a `@handle`, because that is what the server stores — so the settings row for a
  name-only block offers *Remove* and says it is matched by name.
- **The interface is deliberately plain.** One neutral surface, hairline borders,
  no shadows, no icon badges: `src/ui/theme.css` is the whole design system, and
  the CSS custom properties at the top of it are the only knobs. Rows are drawn
  from type and spacing rather than decoration, so a component added without a
  colour or a radius still looks like the rest of the page.
- **A card is filtered after the channel is blocked, not retrospectively.**
  Cards already scrolled past are re-judged when the rules change, but a card
  YouTube has destroyed and rebuilt is judged when it renders.
- The ported matcher covers URL, search-query and YouTube-feed surfaces. Android
  accessibility-only behaviours (incognito-browsing blocking, in-app WebView
  interception, device-admin and DNS controls) have no browser equivalent and are
  not part of the extension.
- Community keywords are distributed after a refresh (TTL 6 h, or on demand), so
  a newly approved rule may take up to that long to appear on a device that is
  not manually refreshed.
