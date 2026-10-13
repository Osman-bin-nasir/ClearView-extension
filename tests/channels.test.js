import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addBlockedChannel,
  channelIdentity,
  channelLabel,
  channelRecord,
  identityFromName,
  matchBlockedChannel,
  normalizeBlockedChannels,
  normalizeChannelId,
  normalizeHandle,
  parseChannelUrl,
  parseVideoUrl,
  removeBlockedChannel,
} from '../src/common/channels.js';
import { buildRuleBundle } from '../src/common/rules-bundle.js';

/** A channel id of the shape YouTube actually issues. */
const UC_A = 'UCabcdefghijklmnopqrstuv';
const UC_B = 'UCzyxwvutsrqponmlkjihgfe';

// ── Parsing a channel URL ────────────────────────────────────────────────

test('the three shapes of a channel URL all yield an identity', () => {
  assert.deepEqual(parseChannelUrl('https://www.youtube.com/@SomeHandle'), {
    handle: '@somehandle',
    channelId: null,
  });
  assert.deepEqual(parseChannelUrl(`https://www.youtube.com/channel/${UC_A}`), {
    handle: null,
    channelId: UC_A,
  });
  // The legacy custom URLs name the same handle with different punctuation.
  assert.deepEqual(parseChannelUrl('https://www.youtube.com/c/SomeHandle'), {
    handle: '@somehandle',
    channelId: null,
  });
  assert.deepEqual(parseChannelUrl('https://www.youtube.com/user/SomeHandle'), {
    handle: '@somehandle',
    channelId: null,
  });
});

test('a channel tab (/videos, /shorts, /about) is still the channel', () => {
  for (const tab of ['videos', 'shorts', 'streams', 'playlists', 'community', 'about']) {
    assert.deepEqual(
      parseChannelUrl(`https://www.youtube.com/@SomeHandle/${tab}`),
      { handle: '@somehandle', channelId: null },
      tab
    );
  }
});

test('a RELATIVE href is a channel URL too', () => {
  // This is the form YouTube puts in a feed card's channel link, and the form
  // a naive `new URL()` rejects.
  assert.deepEqual(parseChannelUrl('/@SomeHandle'), { handle: '@somehandle', channelId: null });
  assert.deepEqual(parseChannelUrl(`/@SomeHandle/videos`), { handle: '@somehandle', channelId: null });
});

test('non-channel YouTube URLs are not channels', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abc123',
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/results?search_query=cats',
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/channel/',
  ]) {
    assert.equal(parseChannelUrl(url), null, url);
  }
});

test('a channel URL on another site is not a channel', () => {
  assert.equal(parseChannelUrl('https://example.com/@SomeHandle'), null);
  assert.equal(parseChannelUrl('not a url at all'), null);
  assert.equal(parseChannelUrl(''), null);
  assert.equal(parseChannelUrl(null), null);
});

// ── Parsing a video URL ──────────────────────────────────────────────────

test('every video URL shape yields the video id', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abc123', 'abc123'],
    ['https://www.youtube.com/shorts/abc123', 'abc123'],
    ['https://youtu.be/abc123', 'abc123'],
    ['https://www.youtube.com/embed/abc123', 'abc123'],
    ['https://www.youtube.com/live/abc123', 'abc123'],
    ['/watch?v=abc123', 'abc123'],
  ];
  for (const [url, id] of cases) {
    assert.deepEqual(parseVideoUrl(url), { videoId: id }, url);
  }
});

test('a non-video YouTube URL yields no video id', () => {
  assert.equal(parseVideoUrl('https://www.youtube.com/@SomeHandle'), null);
  assert.equal(parseVideoUrl('https://www.youtube.com/results?search_query=x'), null);
  assert.equal(parseVideoUrl('https://example.com/watch?v=abc'), null);
});

// ── Normalization ────────────────────────────────────────────────────────

test('handles normalize to one leading @ and lower case', () => {
  assert.equal(normalizeHandle('SomeHandle'), '@somehandle');
  assert.equal(normalizeHandle('@@Some.Handle'), '@some.handle');
  assert.equal(normalizeHandle('  @a  '), null, 'too short to be a handle');
  assert.equal(normalizeHandle('has spaces'), null);
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle(null), null);
});

test('a channel id keeps its case', () => {
  // A channel id is not a slug: folding the case would produce a value that
  // matches nothing, because ids are case-sensitive.
  assert.equal(normalizeChannelId(UC_A), UC_A);
  assert.equal(normalizeChannelId(`  ${UC_B}  `), UC_B);
  assert.equal(normalizeChannelId('not-an-id'), null);
  assert.equal(normalizeChannelId('UCshort'), null);
});

test('a display name collapses to a handle, and a hopeless one yields null', () => {
  // "Some Channel • Music" has no handle form. The punctuation is a display
  // convention and is dropped; the result is a guess, which is why it is only
  // used for matching and never written as a block.
  assert.deepEqual(identityFromName('BlockedChannel'), {
    handle: '@blockedchannel',
    channelId: null,
    name: 'BlockedChannel',
  });
  assert.equal(identityFromName('• • •'), null);
  assert.equal(identityFromName(''), null);
  assert.equal(identityFromName(null), null);
});

test('a URL beats a name when both are offered', () => {
  // The link is YouTube's own claim about which channel this is; a name can be
  // printed identically by two different channels.
  const identity = channelIdentity({ url: `/channel/${UC_A}`, name: 'Some Name' });
  assert.equal(identity.channelId, UC_A);
  assert.equal(identity.handle, null);

  const named = channelIdentity({ name: 'Some Name' });
  assert.equal(named.handle, '@somename');
});

// ── The block list ───────────────────────────────────────────────────────

test('the block list drops junk and collapses duplicates', () => {
  const list = normalizeBlockedChannels([
    { handle: '@one', name: 'One' },
    { handle: 'ONE' }, // same channel, different spelling
    { channelId: UC_A },
    { channelId: UC_A, handle: '@one' }, // the same channel again, now by id
    { handle: 'not a handle' },
    { name: '  ' }, // nothing usable at all
    null,
    'a string is not a record',
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(channelLabel), ['@one', UC_A]);
});

test('a name-only block is labelled by its name', () => {
  const [record] = normalizeBlockedChannels([{ name: 'The Japanese Town' }]);
  assert.equal(channelLabel(record), 'The Japanese Town');
});

test('an unknown source falls back to "manual" rather than being stored raw', () => {
  const [record] = normalizeBlockedChannels([{ handle: '@one', source: 'invented' }]);
  assert.equal(record.source, 'manual');
  const [menu] = normalizeBlockedChannels([{ handle: '@one', source: 'youtube-menu' }]);
  assert.equal(menu.source, 'youtube-menu');
});

test('blocking a channel by id after its handle does not add a second entry', () => {
  const first = addBlockedChannel([], channelRecord({ handle: '@one', name: 'One', source: 'manual' }));
  assert.equal(first.length, 1);

  const same = addBlockedChannel(first, channelRecord({ handle: '@one', channelId: UC_A, source: 'youtube-menu' }));
  assert.equal(same.length, 1, 'the handle already covers it');

  const other = addBlockedChannel(first, channelRecord({ channelId: UC_B }));
  assert.equal(other.length, 2);
});

test('a record is refused only when it has nothing at all in it', () => {
  assert.equal(channelRecord({ handle: '', channelId: '', name: '   ' }), null);
  assert.equal(channelRecord({}), null);
});

test('a NAME alone is a block, and is stored as a name', () => {
  // YouTube's current grid gives a card's channel no href, so a right-click on a
  // feed thumbnail has nothing but the printed name — and refusing it would make
  // the menu entry a dead end. It is stored as what it is, never turned into a
  // handle, and matching reads names.
  const byName = channelRecord({ name: '  The Japanese Town  ', source: 'context-menu' });
  assert.equal(byName.handle, null);
  assert.equal(byName.channelId, null);
  assert.equal(byName.name, 'The Japanese Town');
  assert.equal(byName.source, 'context-menu');
  assert.ok(Number.isFinite(byName.addedAt));
});

test('two name-only records for the same name are one block', () => {
  const first = addBlockedChannel([], channelRecord({ name: 'Some Channel' }));
  assert.equal(first.length, 1);
  assert.equal(addBlockedChannel(first, channelRecord({ name: 'some   channel' })).length, 1);
  assert.equal(addBlockedChannel(first, channelRecord({ name: 'Other Channel' })).length, 2);
  // And a handle block is still its own row, not merged into a name.
  assert.equal(addBlockedChannel(first, channelRecord({ handle: '@somechannel' })).length, 2);
});

test('removing works by handle and by channel id', () => {
  const list = normalizeBlockedChannels([{ handle: '@one' }, { channelId: UC_B }, { handle: '@two' }]);
  assert.deepEqual(removeBlockedChannel(list, '@one').map(channelLabel), [UC_B, '@two']);
  assert.deepEqual(removeBlockedChannel(list, UC_B).map(channelLabel), ['@one', '@two']);
  assert.equal(removeBlockedChannel(list, '@never-blocked').length, 3);
});

// ── Matching ─────────────────────────────────────────────────────────────

test('a channel matches by handle, by id, and by display name', () => {
  const blocked = { channels: new Set(['@one']), channelIds: new Set([UC_B]) };

  assert.equal(matchBlockedChannel(blocked, { handle: '@ONE', channelId: null }), '@one');
  assert.equal(matchBlockedChannel(blocked, { handle: null, channelId: UC_B }), UC_B);
  assert.equal(matchBlockedChannel(blocked, { handle: null, channelId: null, name: 'One' }), '@one');
  assert.equal(matchBlockedChannel(blocked, { handle: '@other', channelId: null }), null);
  assert.equal(matchBlockedChannel(blocked, null), null);
});

test('an empty block list matches nothing, whatever it is asked', () => {
  const blocked = { channels: new Set(), channelIds: new Set() };
  assert.equal(matchBlockedChannel(blocked, { handle: '@one', channelId: UC_A, name: 'One' }), null);
});

test('a card that gives only a displayed NAME matches the name that was blocked', () => {
  // YouTube's CURRENT grid renders the channel as an attributed string with a
  // click command and no href, so a card can offer nothing but the printed
  // name — and a handle derived from a name ("@thejapanesetown") is not that
  // channel's real handle ("@thejapanesetown-jt6fy").
  const blocked = {
    channels: new Set(['@thejapanesetown-jt6fy']),
    channelIds: new Set(),
    channelNames: new Set(['the japanese town']),
  };

  assert.equal(
    matchBlockedChannel(blocked, { handle: null, channelId: null, name: 'The Japanese Town' }),
    'the japanese town'
  );
  assert.equal(
    matchBlockedChannel(blocked, { handle: null, channelId: null, name: 'Some Other Channel' }),
    null
  );
  // A name matches whatever its spacing and casing, and the handle still wins
  // when the card can offer one.
  assert.equal(
    matchBlockedChannel(blocked, { handle: null, channelId: null, name: 'the   JAPANESE town' }),
    'the japanese town'
  );
  assert.equal(
    matchBlockedChannel(blocked, {
      handle: '@TheJapaneseTown-jt6fy',
      channelId: null,
      name: 'whatever',
    }),
    '@thejapanesetown-jt6fy'
  );
});

test('unblocking accepts the displayed name that matching reported', () => {
  // `channel/status` hands the UI whatever matched, and the UI unblocks with
  // that value — so a match BY NAME has to be removable by name, or the button
  // would say it worked and change nothing.
  const list = normalizeBlockedChannels([
    { handle: '@thejapanesetown-jt6fy', name: 'The Japanese Town' },
    { handle: '@other', name: 'Other' },
  ]);
  assert.deepEqual(
    removeBlockedChannel(list, 'the japanese town').map(channelLabel),
    ['@other']
  );
  assert.equal(removeBlockedChannel(list, '@nobody').length, 2, 'an unmatched name removes nothing');
});

// ── The bundle ───────────────────────────────────────────────────────────

test('the rule bundle carries both handles and channel ids', () => {
  const bundle = buildRuleBundle(
    {
      strictMode: false,
      blockedDomains: [],
      userKeywords: [],
      youtubeKeywords: [],
      blockedChannels: [{ handle: '@one' }, { channelId: UC_B }, { handle: 'not a handle' }],
    },
    null
  );
  assert.deepEqual(bundle.channels, ['@one']);
  assert.deepEqual(bundle.channelIds, [UC_B]);
});

test('the rule bundle carries the blocked display names alongside the handles', () => {
  // They are carried for one reason: a card that gives no channel link can only
  // be matched by the name it prints.
  const bundle = buildRuleBundle(
    {
      strictMode: false,
      blockedDomains: [],
      userKeywords: [],
      youtubeKeywords: [],
      blockedChannels: [
        { handle: '@one', name: 'One Channel' },
        { handle: '@two' },
      ],
    },
    null
  );
  assert.deepEqual(bundle.channels, ['@one', '@two']);
  assert.deepEqual(bundle.channelNames, ['one channel']);
});

test('a channel rule from the shared list is merged with the user’s own', () => {
  const bundle = buildRuleBundle(
    {
      strictMode: false,
      blockedDomains: [],
      userKeywords: [],
      youtubeKeywords: [],
      blockedChannels: [{ handle: '@mine' }],
    },
    { keywords: [], channels: [{ handle: '@theirs' }] }
  );
  assert.deepEqual(bundle.channels, ['@mine', '@theirs']);
  assert.deepEqual(bundle.channelIds, []);
});
