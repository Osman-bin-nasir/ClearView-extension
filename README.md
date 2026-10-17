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
  muted and chased off at 16× in a fraction of a second — with the ad's own
  countdown and badges hidden — without touching the video you are watching. One
  toggle turns the whole thing off.
- **A mandatory Protection password.** Setup is the first screen after install:
  no settings exist until the password does, and every settings write is refused
  by the worker until then. After that, turning Protection on or off asks for it.
  It is a device lock, not an account — see §12.
- Hides **YouTube Shorts** — the sidebar and mini-guide entry points, the chip
  above the feed, the Shorts shelf and its individual cards, and the channel
  page's Shorts tab — **and** blocks Shorts links, matching the app's
  `blockShorts` control.
- **Block a YouTube channel** from a video's ⋮ menu, a Short's ⋮, or by
  right-clicking a thumbnail — no need to open the video first. Its videos leave
  your feeds, its search result disappears, and its channel page and videos will
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
   popup — once Protection is on it is the ClearView name, *Total blocked* and
   *Today blocked*, and **Open settings** into the complete Block tab. The
   Protection switch appears only while protection is OFF.

No build step is required — the extension is plain ES modules and ships as-is.

**Requirements:** Chrome 102+ (for the `declarativeNetRequest` `extensionPath`
redirect), Node 20+ only if you want to run the tests or regenerate the rules.

---

## 2. Configure

Open the settings page — **Open settings** on the popup, or `chrome://extensions` →
*Extension options*. It is a sidebar of seven sections — Protection, YouTube,
Blocked items, Community, Activity, Security and Advanced — with the long
keyword/channel lists behind a **Show more** button that opens the whole list on a
page of its own — searchable, with room for every row — instead of stretching the
settings page.

| Setting | Purpose |
| --- | --- |
| **Protection** | Master switch. Off means nothing is blocked at all. Always gated by the password. |
| **Protection password** | Required device lock, created at first run. Change it from *Security*; it cannot be removed. |
| **Strict Mode** | Adds the app's discovery terms (bikini, lingerie, …). |
| **Block YouTube ads** | Refuses YouTube ad requests, removes ad slots, and chases off video ads (muted, at 16×, with the ad's own UI hidden). On by default. |
| **Block YouTube Shorts** | Hides the Shorts entry points, the feed shelf and its cards, and blocks Shorts links (app parity). |
| **Brain Bot Protection** | Filters YouTube feed cards. Choose *Remove from feed* or *Show protection overlay*. |
| **Blocked websites / keywords** | Your own rules. Keywords apply to every site and search. |
| **Brain Bot keywords** | Keywords matched against YouTube titles only. |
| **Blocked channels** | Channels you blocked, with *Remove* and *Ask to block for everyone* on each. Stored by `@handle` and by channel id where they are known, so a rename never loses the block; a block made from a feed card that carries no link is stored and matched by the channel's printed name, and says so. |
| **Backend server** | Defaults to the deployed ClearView server. Change for self-hosting. |
| **Anonymous identity** | The random install id your contributions are sent with. |
| **Your data** | *Export my data* downloads settings, blocked items, activity and the anonymous id as JSON (never the password or admin session). *Erase all data* clears both storage areas and returns the page to setup. |
| **Privacy** | What stays on the device and what can leave it, with a link to the full **privacy policy** page (`src/privacy/privacy.html`, linked from here — the popup holds one link, into these settings). |

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

  **The overlay is a block, not a decoration.** It is drawn on the card's
  *thumbnail only* — the title and byline stay readable — and it names what
  matched (`Blocked by ClearView` / `Matched “…”`), because a block the user
  cannot account for is one they cannot judge. A blocked channel is presented
  the same way as a keyword match: the display mode chooses cover or removal for
  both, so a channel the user just blocked cannot vanish before the reason can be
  read. The cover is a **near-solid black** panel, and it is a signpost: the report
  action lives on the video's own page, not on the feed thumbnail.

  **A covered thumbnail can never play a hover preview — and a hover cannot wipe
  the cover.** Covering the thumbnail is not enough on its own: YouTube starts a
  muted inline preview as the pointer rests on a card, and it can hang that
  preview off the page instead of inside the card. So:

  - the stylesheet hides every preview surface — including any `video` inside a
    protected card;
  - hovering a protected card sets a page-wide `cv-protected-hover` lock that
    hides preview surfaces everywhere, backed by a 120 ms burst that pauses them
    (a preview created after the pointer arrived is caught as it appears);
  - the card's verdict is kept on its record, so if the hover wipes the cover
    (YouTube replaces the thumbnail's contents) it is rebuilt in place at once,
    with no worker round-trip;
  - a capture-phase `play` guard pauses any preview that starts between passes —
    scoped to a protected card, or to the page while a protected card is hovered,
    so an ordinary card's preview is untouched.

  A sweep on each debounced pass repeats the same work for cards YouTube
  re-renders without a pointer event, because a preview that keeps playing is
  still playback.

  **A covered video is paused, not unavailable.** Clicking the cover (or the
  card's title) opens the video page normally; there the content script asks the
  worker whether the video is blocked and, if so, pauses it behind a panel over
  the *player* only. The description, channel and **comments stay readable**, and
  the panel carries **Report false positive** — so a mistaken block can be judged
  and reported without leaving the page. The report sends the matched rule *and*
  the video URL, in the one free-text field the reports endpoint already accepts
  (`Video: … | Title: … | Channel: …`), which is what lets an administrator see
  exactly which video was wrongly blocked. The playback guard pauses the element
  again if anything tries to resume it, and the block is removed on the next
  `yt-navigate-finish`.

  **A decision lasts only as long as its effect.** The record says what the
  script *decided*, not what the page currently shows — and YouTube re-stamps and
  re-attaches whole feed subtrees, which takes the overlay (or the `display: none`)
  with it. A verdict is therefore treated as stale the moment its effect has left
  the document, so the overlay is rebuilt on the next pass instead of the card
  reporting itself as handled while the page shows it unlocked.
- **The feed pass is bounded.** Only cards within ~600px of the viewport are
  judged; the rest are picked up by the scroll pass, so a 500-card feed does not
  become one worker request. Verdicts are cached by title + channel for the life
  of the current rules fingerprint (`verdictCache`), because a feed repeats the
  same identities and re-asking about them is pure traffic. A rules change clears
  the cache and resets every card.
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
3. **A video ad that still starts is chased off, not waited out.** The pass tries
   the player's own `skipAd` API, clicks YouTube's skip control (every variant,
   repeatedly), dismisses an overlay/banner ad, and for an ad that cannot be
   dismissed **runs it out at 16×** while muting it. A one-second heartbeat is too
   slow for a short pre-roll, so a short, self-cancelling **burst** of passes runs
   at 120 ms while the player is showing an ad, re-applying the seek because the
   player can reset `currentTime` when it hands the element over. The ad's own
   furniture — countdown, badge, "your video will play after the ad", click-through
   overlay — is hidden, so an ad that cannot be unloaded at least does not
   announce itself.

   *What no extension can promise:* YouTube now stitches many ads into the video
   stream itself (SSAP), where the ad and the video are one response. There is no
   URL to block and no separate element to remove, so the honest guarantee is
   "the ad is over in a fraction of a second and never makes a sound", not
   "the ad does not exist". Everything addressable at all is listed above.

The mute AND the playback rate the unskippable path applies are recorded on the
element and both undone the moment the ad ends, so the video the user came to
watch is never left silent or stuck at 16×. The burst of passes is cancelled with
the ad, so nothing keeps running in the background afterwards.

The toggle (`blockYoutubeAds`) follows the same rule as the other content
controls: it is inert while **Protection** is off, and the ruleset is enabled by
the worker (`installAdRules`) rather than by a page.

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

  The same entry is added to a **Short's** ⋮ in the reels player, and to a
  Shorts card in a feed shelf. The player is a card in every way that matters —
  title, channel and three dots — and its live menu is the same contextual sheet
  as the grid's, rendered into the document-level popup container. Its title is
  read from `yt-shorts-video-title-view-model` (the live player's h1), because
  the old reel header had already been replaced; reading only that left the
  title empty, so a keyword could never match a Short.

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

Open it from the settings page (`src/admin/admin.html`, also available at
`chrome://extensions` → *Extension options*… → *Admin dashboard*). The popup no
longer carries a second door to it: it holds one link, into the settings, and
everything is behind that.

- Sign in with an **administrator email and password**.
- **There is no sign-up, and none is missing.** The form is a sign-in only: an
  administrator exists because a row was created for one on the backend, and
  `POST /admin/api/auth/login` answers `401 invalid_credentials` for anything
  else. The page says so on a refusal, because "invalid credentials" from a form
  with no "create account" next to it reads like a broken button.
- Tabs: **Overview** (review totals + most-requested targets), **Review queue**
  (approve / reject / mark under review), **Published rules** (enable, disable,
  remove), **False positives**.
- **False positives are grouped by what was blocked.** One card per channel (or
  keyword) says how many users reported it; tapping it opens the reports, and
  every reported **video is a link the administrator can watch**. The overlay's
  report carries the URL, and the dashboard reads it back out of the detail line,
  so no backend schema change is needed. Each group still offers *Keep rule* and
  *Remove rule*.
- **The Overview shows contested rules.** Each request row carries its
  false-positive count and share (`reports / (requests + reports)`, so it can
  never exceed 100%), a rule with three or more reports is badged *contested*, and
  a **Contested rules** card lists them with their latest report time. The
  **False positives** tab opens with a seven-day report strip, so a rule that
  suddenly collects reports overnight reads differently from one that has sat at
  the same count for a month.

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
| `storage` | Settings, cached rules, stats, anonymous id, and the local password hash. |
| `webNavigation` | To see a navigation's URL — a page load AND a same-document `pushState` — and redirect it. |
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
npm test        # node --test "tests/**/*.test.js"   (offline, no network)
npm run canary  # fetch YouTube and check the anchors the content script needs
```

`npm run canary` is deliberately outside the test suite: a network flake is not a
code failure, and the suite must pass offline. Run it on a schedule before a
release. It exits `0` when every required anchor is present, `1` when one is
missing, and `2` when the pages could not be fetched (inconclusive, never a
pass).

262 tests, covering:

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
  once, placed first so a scrolling menu cannot hide it, and also placed in the
  Shorts player's sheet, whose list does not always carry `role="menu"`).
- **`tests/context-menu-flow.test.js`** — the right-click flow end to end, with
  the real worker against a stubbed `chrome`: what is written to storage for a
  channel link, for a card that gives only a name, and for a target with nothing
  in it (refused).
- **`tests/content-shorts.test.js`** — static guards on the shipped Shorts
  artefacts: the `/shorts` link is matched by **prefix**, the label is matched on
  the element *and* on a descendant, the feed shelf / reel shelf / Short card /
  Shorts tab are all covered by the stylesheet *and* the script, the hiding is
  reversible, and a Short is a Brain Bot card in BOTH the reels player (its live
  title view model, pausing the playing video) and a feed shelf (judged once).
- **`tests/blocked-page.test.js`** — the blocked destination page: it asks the
  user for nothing, its Back button leaves for YouTube home, every reason the
  worker can emit has copy on it, and it never reprints what was blocked.
- **`tests/brainbot-overlay.test.js`** — the Brain Bot overlay: it is drawn on the thumbnail
  with the reason it was blocked, as a near-solid black panel with a text report link living on
  the blocked *player* instead of the feed; a decision is treated as stale once its effect has
  left the page (the overlay YouTube threw away is rebuilt); a covered card stops any hover
  preview by selector, by `mouseover` and on every pass; and the stylesheet's z-index is high
  enough that YouTube's own thumbnail buttons cannot sit on top of the block.
- **`tests/icons.test.js`** — the icon pipeline: the PNG helpers round-trip and box-downscale to
  a hand-computed answer, the committed icons are the committed logo at each declared size (so a
  drifted icon or a broken generator fails), the manifest points at exactly those files, and
  every page shows the bundled logo rather than an emoji stand-in.
- **`tests/privacy-page.test.js`** — the privacy policy page: it ships and links back to the
  settings, it carries no script and no request of its own, it states the disclosures it has to
  (on-device checking, no browsing history, the random id, the local password hash, how to delete
  data), and the settings page points at a path that exists — the popup reaches the policy
  through those settings, and the test pins that too.
- **`tests/options-layout.test.js`** — the ask-to-block row: a select inside a field row is sized
  to its own content, so the value field next to it keeps its space (the shared `.input`/`.select`
  rule makes both full width, which had left the field with nothing to type into), and the row
  still builds the picker, the field and the placeholder swap.
- **`tests/options-identity.test.js`** — the anonymous identity row, and the
  *New identity* option that is gone: the button, the message behind it, the
  worker's handler and the two helpers are all checked absent, so a
  half-removed feature cannot be re-wired by accident.
- **`tests/feed-cards.test.js`** — static guards on how a feed card is read and
  remembered: the current grid's title is read as well as the classic
  `#video-title`, a card with no channel link falls back to its printed name (and
  a views row is never mistaken for one), a channel RESULT in a search is a card
  like any other (and the name-bearing link wins over the avatar link), a Short
  is a card in both the reels player and a feed shelf (its live title comes from
  the player's own view model), the worker's rules fingerprint is what makes a
  past verdict stale, the ⋮ menu entry
  is placed where a long menu cannot hide it, a channel page is checked by name
  as well as by URL, and a removal is not undone by its own cleanup.
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
  content pass removes AND restores, the player's own `skipAd` is tried, an
  unskippable ad is run out at 16× on a 120 ms burst with the user's rate restored
  afterwards, the ad's own interface is hidden, and the Protection change is
  gated in the worker rather than the UI.
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
  real against a small DOM shim: the popup's activity panel with the switch
  hidden while protection is on (and drawn only while it is off), the controls that
  must NOT be on the popup, the mandatory setup gate (the page is nothing else
  until a password exists), the settings page's cards, the *Show more* full-page
  list (keywords, blocked channels, submissions and protection history), and the
  dialog's mismatch/cancel/retry behaviour.
- **`tests/admin-reports.test.js`** — the false-positive queue on the dashboard:
  reports are grouped by channel/keyword, tapping a group opens it, each reported
  video is a real link that opens in a new tab, the URL and channel are read back
  out of the report's `detail` line, the Overview shows a per-rule false-positive
  rate and a contested list, the reports tab carries a seven-day trend, and the
  dashboard keeps its flat layout.
- **`tests/maintenance.test.js`** — the YouTube selector canary: it is wired to
  `npm run canary`, checks the anchors the content script actually uses, treats an
  unreachable page as inconclusive rather than a pass, and is deliberately not
  part of the offline test suite.

### Manual acceptance checklist

| Requirement | Where to verify |
| --- | --- |
| Explicit website blocked | Visit a blocked host → the ClearView blocked page. |
| Explicit search redirected, no query carried | Search an explicit term → lands on Google with no query in the URL. |
| Normal searches unaffected | Search anything ordinary. |
| Shorts gone: entry points, feed shelf, Shorts cards, channel tab | Toggle on, reload YouTube, scroll the home feed, open a channel page, open a `/shorts/…` link (blocked). |
| **YouTube ads blocked** | With the toggle on, reload YouTube: no pre-roll, no feed/sidebar ad slots, no banner. Turn it off and the ad slots return on the next reload. |
| **Mandatory setup** | On a fresh install the settings page is only a password form: no settings, no skip. Close it and reopen — it is still there, and the popup says *Finish setup*. |
| **Nothing changes before setup** | On a fresh install, a settings write from the console (`settings/update`) is refused with `password_required`. |
| **Protection gated by the password** | Flip Protection on the popup or the settings page — it asks for the password, a wrong one changes nothing, and five wrong guesses lock the check for a minute. |
| **Export / erase** | Settings → Advanced → *Export my data* downloads a JSON file without any credential; *Erase all data* asks for confirmation, then returns the page to setup. |
| Brain Bot remove / overlay | Toggle each mode on a home feed. |
| Dynamic navigation | Scroll the feed; overlays must not duplicate. |
| **Block a channel from ⋮** | Open a video, use the ⋮ menu → *Block this channel*; the entry then reads *Unblock this channel*. |
| **Block a Short’s channel from its ⋮** | Open `/shorts/…`, use the three-dot menu → *Block channel*: the toast names the channel, and the Short is covered (overlay) or removed (remove) and paused. |
| **A Shorts shelf card responds too** | A blocked channel or matching keyword covers or removes its Short in the home shelf, not only in the player. |
| **Block a channel by right-click** | Right-click a thumbnail → *Block this channel (ClearView)*. On the current grid the card carries no channel link: the block is then recorded by name, and the toast says which name. |
| **A blocked channel’s search result is gone** | Search the channel's name: no avatar result, no Subscribe button, for it — and other channels' results are untouched. |
| **A blocked channel is gone** | Its cards leave home/search/subscriptions (both card markups — the `yt-lockup-view-model` grid and the classic list), `/@handle` and `/channel/UC…` show the blocked page, and its video pages redirect there. |
| **A block made on a video page reaches the feed** | Block from a video's ⋮ menu, go back to the feed, scroll: no card from that channel, including ones already on screen. |
| **Brain Bot overlay is visible** | Switch to *Show protection overlay* with a keyword that matches: the card stays, its **thumbnail** is covered by a *Blocked by ClearView* overlay naming the matched term, and switching to *Remove* makes the same card leave. |
| **A covered card opens a blocked player** | In overlay mode, click the covered thumbnail: the video page opens with the player blocked and paused, while the description and comments remain readable and the block offers *Report false positive*. Press play: it pauses again. The card's ⋮ still opens, with *Unblock* in it. |
| **A blocked channel gets the overlay too** | Block a channel, return to the feed: its card stays, with only the thumbnail covered and the title readable — exactly like a keyword match. |
| **A false positive can be reported** | In overlay mode, click a covered thumbnail, then *Report false positive* on the blocked player: the link changes to *Reported — thanks*, the video stays paused, and the dashboard shows the report under that channel with the video URL. |
| **A covered thumbnail never previews** | Hover a covered card for several seconds: no muted preview plays, and no sound is heard. |
| **Ads cost a moment, not a minute** | Open a video whose ad cannot be blocked at the network layer: the ad is muted and gone in a fraction of a second, with no countdown, badge or "your video will play after the ad" message on screen. |
| **The overlay survives a feed re-render** | In overlay mode, scroll the feed away and back: a blocked card comes back still covered rather than showing its thumbnail uncovered. |
| **The extension icon is the brand logo** | `chrome://extensions` and the toolbar show the ClearView logo — not the old shield. |
| **Right-click off-target is refused** | Right-click a link in a video description → a message, and no block. |
| **Ask to block: the field is typeable** | Settings → *Ask to block it for everyone*: the Keyword / Channel handle picker sits beside a text field, not in place of it, and the field follows the picker. |
| **Privacy policy opens** | Settings → *Privacy* → *Read the privacy policy*, and the popup's *Open settings* then that card. |
| **The popup is minimal** | Click the toolbar icon with Protection on: the ClearView title, *Blocked today*, the 7-day and all-time totals with a seven-day bar strip, and a quiet *Open settings* row — no switch. Turn Protection off: the switch appears so it can be turned back on. Nothing scrolls and nothing overlaps. |
| **Long lists open on their own page** | Add more than four keywords, blocked channels or submissions (or block more than eight things): the card shows a preview and *Show more (N)*, which opens a full page with a search field; removing a row updates it in place. |
| **Today's number** | After a block, *Today blocked* goes up by one and *Total blocked* by one. Open it the next morning: today reads 0 again, the lifetime number does not. |
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
  content/                    YouTube content script (Shorts, ads, Brain Bot)
  popup/                      ClearView and compact activity; a switch only while off
  options/                    Sidebar settings page (the full Block tab)
  admin/                      Protected moderation dashboard
  blocked/                    Blocked destination page
  privacy/                    The privacy policy page (static, no script)
  ui/                         Shared design system + helpers
    theme.css                 The minimalist design system (light + dark)
    shared.js                 DOM builder, cards, switch, toast
    password.js               The password dialog and the mandatory setup form
scripts/
  extract-builtin-rules.mjs   Regenerate rules from the Android app
  make-icons.mjs              Derive the four icons from icons/logo.png (no dependencies)
  png.mjs                     The PNG read/resample/write the icon generator uses
  make-config.mjs             Turn .env into src/common/env.config.js
  check-youtube-selectors.mjs `npm run canary`: fail loudly if YouTube's anchors move
icons/
  logo.png                    The ClearView brand logo, the source of every icon
  icon16/32/48/128.png        GENERATED from logo.png by `npm run icons`
tests/                        node --test suite
```

---

## 10. Privacy and security

- The full policy is a page of its own, `src/privacy/privacy.html`, linked from the settings
  *Privacy* card — the popup is the name, compact activity and a link into those settings, and the
  policy is one step in. It is **static HTML with no script** — a page whose job is
  to say what does not leave the browser should be incapable of sending anything itself.
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
- **The protection overlay is injected, like the ⋮ entry.** It is a plain `div`
  appended to the card's thumbnail element and re-created whenever YouTube throws
  it away. The host is chosen by `thumbnailHost`: a thumbnail container that does
  not contain the card's title first, the box around the card's image second, and
  only if neither exists a compact banner inside the card — never a full-card
  cover, because that would hide the title. The title is also raised above the
  overlay in the stylesheet as a last line of defence. The card's toggle buttons
  (⋮, Watch later) stay live: none of them plays the video, and the ⋮ is where
  *Unblock* lives.
- **The interface is deliberately quiet.** One accent, a neutral surface scale,
  hairline borders and one soft shadow: `src/ui/theme.css` is the whole design
  system, and the CSS custom properties at the top of it are the only knobs. Rows
  are drawn from type and spacing first — the icon badge is the only decoration a
  card carries, so a component added without a colour or a radius still looks
  like the rest of the page.
- **A card is filtered after the channel is blocked, not retrospectively.**
  Cards already scrolled past are re-judged when the rules change, but a card
  YouTube has destroyed and rebuilt is judged when it renders.
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
  frame before the content pass acts. Skipping is reactive by nature. Ads
  stitched into the video stream (SSAP) cannot be removed at all — the pass mutes
  them and chases them off at 16×, which is the best any browser extension can
  honestly promise for those.
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

A **mandatory** lock on the **Protection** switch, created at first run
(`src/common/password.js`, `src/ui/password.js`).

- **Setup cannot be skipped.** A fresh install opens the settings page at a
  password form and nothing else — no navigation, no cards, no switch. Closing the
  tab does not postpone it: the next visit lands on the same form, and the popup
  says *Finish setup*.
- **Nothing can be changed before it exists.** The worker refuses every
  `settings/update` with `password_required` until a password is set. That is what
  makes it mandatory in practice rather than a dialog a page can skip: a fresh
  install has no password-less window in which Protection could be turned off.
- **What it guards.** Turning Protection on or off, from any screen, via the
  worker's `settings/update` — the one path every change goes through. Other
  settings depend on the password existing, but do not ask for it every time.
- **Lockout.** Five wrong guesses lock the check for a minute
  (`cv.passwordAttempts`, local like the hash). A correct password clears the
  count; while locked, even the right password waits.
- **What it is not.** A device lock, not an account and not authentication. It
  stops a one-click change on a shared or borrowed machine. It cannot hide
  anything from someone with full access to the browser profile, and the UI says
  so rather than implying otherwise.
- **How it is stored.** Never the password itself: a random 16-byte salt and a
  PBKDF2-SHA256 hash (120,000 iterations), written to `chrome.storage.local`.
  Local and not synced, because a credential has no business travelling to
  another machine with the settings. Verification is a constant-time comparison,
  and every failure returns the same answer.
- **Changing it.** From the settings page's *Security* section, with the current
  password. There is no *Remove password* action: the password is required, so
  removal would only bounce the user back to setup.
- **Forgetting it.** Erase the extension's data (*Advanced → Erase all data*) or
  clear the extension's storage. This is stated plainly rather than dressed up as
  a recovery flow — there is no recovery channel by design.
