const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const collections = require('./collections');
const reviews = require('./reviews');
const statsUi = require('./statsUi');
const { paletteFor, bannerUrlFor, headerUrlFor, collageUrl, warmHeader } = require('./themes');
const { getMediaLite, getMediaBatch, getProfileSnapshot } = require('./anilistSocial');
const { pickTags } = require('./tags');
const { ctx } = require('./ctx');
const artRoutes = require('./artRoutes');
const { getRecentActivities } = require('../anilist');

/* ---------------------------------------------------------------------------
 * /profile — a personal anime page, built as an interactive card.
 *
 *   Overview | Favorites | Reviews | Collections | Stats | Activity
 *
 * The Overview is assembled from the sections the owner picked in /settings,
 * in the order their layout defines, and painted in their theme colours.
 * Someone who never customised gets a clean default (AniList blue) plus a
 * nudge to make it theirs.
 *
 * ids:
 *   p:t:<owner>:<tab>:<page>     switch tab / page
 *   p:pick:<owner>:<tab>         open an item (review / collection) from a tab
 *   p:bm:<owner>                 bookmark someone's recommendation to your Watch Later
 *
 * Clicking someone else's public profile gives YOU a private copy of the
 * view instead of changing the message for everyone.
 * ------------------------------------------------------------------------- */

const TABS = {
  overview: { label: 'Overview', emoji: '🏠' },
  favorites: { label: 'Favorites', emoji: '⭐' },
  reviews: { label: 'Reviews', emoji: '✍️' },
  recs: { label: 'Recs', emoji: '💜' },
  collections: { label: 'Collections', emoji: '🗂️' },
  stats: { label: 'Stats', emoji: '📊' },
  activity: { label: 'Activity', emoji: '📡' },
};

// One consistent nav block: same emoji style and label length everywhere,
// the current tab in the accent (blurple), the rest neutral. Customizing
// lives in /settings, not here.
function navRows(ownerId, tab) {
  const b = (t) =>
    ui.button(`p:t:${ownerId}:${t}:0:n`, TABS[t].label, { emoji: TABS[t].emoji, style: t === tab ? ui.ButtonStyle.Primary : ui.ButtonStyle.Secondary });
  return [ui.actionRow(b('overview'), b('favorites'), b('reviews')), ui.actionRow(b('collections'), b('stats'), b('activity'))];
}

async function discordUser(id) {
  try {
    return ctx.client.users.cache.get(id) || (await ctx.client.users.fetch(id));
  } catch {
    return null;
  }
}

// Identity block: big name, the tagline right under it as a quote, then the
// quiet details. When the avatar is already painted into the header image
// (overlapping the banner) it isn't repeated here.
// Identity block: name with any badges and the status right beside it,
// the bio directly underneath, then the quiet details.
function identityLines(u, user, al, pal, ownerId) {
  const name = u.profile.displayName || user?.globalName || user?.username || 'Unknown';
  const badges = social.badgesFor(ownerId).map((b) => `  \`${b.label}\``).join('');
  const status = u.profile.tagline ? `  ·  *${ui.softEsc(u.profile.tagline)}*` : '';
  const meta = [user?.username ? `@${user.username}` : null, al ? `[AniList ↗](${al.siteUrl})` : null, `${pal.name} theme`].filter(Boolean).join('  ·  ');
  const lines = [`## ${ui.esc(name)}${badges}${status}`];
  if (u.profile.bio && u.profile.sections.includes('bio')) lines.push(ui.softEsc(u.profile.bio));
  lines.push(`-# ${meta}`);
  return lines;
}

function header(u, user, al, pal, { avatarInImage = false, ownerId } = {}) {
  const lines = identityLines(u, user, al, pal, ownerId);
  if (avatarInImage) return ui.text(lines.join('\n'));
  // a Section holds at most 3 text blocks
  return ui.row([lines[0], lines.slice(1, -1).join('\n') || null, lines[lines.length - 1]].filter(Boolean), user?.displayAvatarURL?.({ size: 512, extension: 'png' }));
}

/* ----------------------------- overview parts ----------------------------- */

function statsStrip({ su, tz, snap }) {
  const streak = engine.streakOf(su, tz);
  const L = snap?.lifetime;
  const bits = [];
  bits.push(`🔥 **${streak.current}**-day streak`);
  if (L) {
    bits.push(`**${ui.num(L.episodes)}** episodes`);
    bits.push(`**${ui.num(L.completed)}** completed`);
    bits.push(`**${ui.hours(L.minutes)}** hours`);
  }
  return ui.text(bits.join('　·　'));
}

const parts = {
  bio: ({ u }) => (u.profile.bio ? [ui.text(ui.softEsc(u.profile.bio))] : []),

  stats: (d) => {
    if (!d.al) return d.own ? [ui.text('-# 📊 Link your AniList with `/signin` to show your streak and totals here.')] : [];
    if (!social.canView(d.u, d.viewerId, d.ownerId, 'stats')) return [];
    return [statsStrip(d)];
  },

  // Featured anime: a big banner, the title, tags and the note (no cover icon).
  featured: ({ u, featuredBanner, featuredMedia }) => {
    const f = u.profile.featured;
    if (!f) return [];
    const meta = [f.year, f.format && f.format.replace('_', ' '), f.episodes ? `${f.episodes} episodes` : null].filter(Boolean).join('  ·  ');
    const out = [ui.text(ui.label('✦ Featured'))];
    // skip the banner here if the whole profile header already uses it
    if (u.profile.bannerMode !== 'featured') {
      const g = ui.gallery([{ url: artRoutes.featuredUrl(f.mediaId) || featuredBanner }]);
      if (g) out.push(g);
    }
    const tags = pickTags(featuredMedia?.tags, featuredMedia?.genres || f.genres, 5);
    const lines = [`## [${ui.esc(ui.clip(f.title, 70))}](${f.siteUrl})`];
    if (meta) lines.push(`-# ${meta}`);
    if (tags.length) lines.push(tags.map((t) => `\`${ui.esc(t)}\``).join(' '));
    if (f.note) lines.push(`> ### ${ui.softEsc(ui.clip(f.note.replace(/\s+/g, ' '), 200))}`);
    out.push(ui.text(lines.join('\n')));
    return out;
  },

  // Favorites: up to three banner cards with titles (one image).
  favorites: ({ u, pal }) => {
    if (!u.favorites.length) return [];
    const border = u.profile.favBorder === 'theme' ? pal.accent : null;
    const url = artRoutes.favoritesUrl(u.favorites.slice(0, 3).map((e) => e.mediaId), u.favorites.length, border) || collageUrl(u.favorites.slice(0, 3).map((e) => e.mediaId));
    const g = url ? ui.gallery([{ url }]) : ui.coverGallery(u.favorites.slice(0, 4).map((e) => ({ url: e.cover, description: e.title })), { single: 'row' });
    // The new card has "FAVORITES · n" painted in; older fallbacks need the label.
    const out = artRoutes.enabled() ? [] : [ui.text(ui.label(`Favorites · ${u.favorites.length}`))];
    if (g) out.push(g);
    return out;
  },

  // In Rotation: the top shows as cards in one image (cover in a progress
  // ring, title, season · progress · status, tags). Text rows if images are off.
  rotation: ({ rotation, pal }) => {
    if (!rotation?.length) return [];
    const top = rotation.slice(0, artRoutes.ROTATION_CARDS);
    const url = artRoutes.rotationUrl(top);
    const g = url ? ui.gallery([{ url }]) : null;
    const out = [ui.text(`${ui.label(`In Rotation · ${rotation.length}`)}${rotation.length > top.length ? `\n-# +${rotation.length - top.length} more in Collections → In Rotation` : ''}`)];
    if (g) out.push(g);
    else out.push(...collections.rotationRows(rotation.slice(0, 2), pal.accent));
    return out;
  },

  opening: ({ u }) => songBlocks(u, 'OP'),
  ending: ({ u }) => songBlocks(u, 'ED'),

  review: ({ s, u, ownerId, viewerId }) => {
    if (!social.canView(u, viewerId, ownerId, 'reviews')) return [];
    const mine = social.reviewsBy(s, ownerId);
    const r = (u.profile.featuredReviewId && s.reviews[u.profile.featuredReviewId]) || mine[0];
    if (!r) return [];
    return [
      ui.row(
        [
          ui.label(`${r.id === u.profile.featuredReviewId ? 'Featured review' : 'Latest review'} · ${ui.stars10(r.rating)} ${r.rating}/10`),
          `**${ui.esc(ui.clip(r.title, 70))}** — ${ui.esc(ui.clip(r.mediaTitle, 40))}`,
          r.spoiler ? '-# ⚠️ Contains spoilers — open it from the Reviews tab' : ui.softEsc(ui.clip(r.content.replace(/\s+/g, ' '), 160)),
        ],
        r.cover
      ),
    ];
  },

  recommendations: ({ u, ownerId, viewerId }) => {
    if (!u.recommendations.length || !social.canView(u, viewerId, ownerId, 'recommendations')) return [];
    const lines = u.recommendations
      .slice(0, 3)
      .map((e) => `💜 **[${ui.esc(ui.clip(e.title, 40))}](${e.siteUrl})**${e.message ? ` — “${ui.softEsc(ui.clip(e.message, 70))}”` : ''}`);
    return [ui.text(`${ui.label(`Recommends · ${u.recommendations.length}`)}\n${lines.join('\n')}`)];
  },

  collections: ({ u, ownerId, viewerId }) => {
    if (!social.canView(u, viewerId, ownerId, 'collections')) return [];
    const visible = u.collections.filter((c) => viewerId === ownerId || c.visibility !== 'private');
    if (!visible.length) return [];
    return [ui.text(`${ui.label('Collections')}\n${visible.slice(0, 5).map((c) => `${c.emoji || '🗂️'} **${ui.esc(c.name)}** \`${c.items.length}\``).join('　')}`)];
  },
};

// Favorite openings / endings: one card image (cover, song, artist, anime,
// OP badge) and a play button per song underneath.
function songLink(o) {
  return o.videoUrl || o.pageUrl || `https://www.youtube.com/results?search_query=${encodeURIComponent(`${o.animeTitle} ${o.slug} ${o.song || ''}`)}`;
}
function songBlocks(u, kind) {
  const list = social.songsOf(u.profile, kind).slice(0, social.MAX_SONGS);
  if (!list.length) return [];
  const url = artRoutes.songsUrl(kind, list);
  const buttons = ui.actionRow(list.map((o) => ui.linkButton(songLink(o), ui.clip(`${o.slug.replace(/^(OP|ED)(\d+)/i, '$1 $2')} · ${o.song || 'Play'}`, 80), '▶️')));
  if (url) return [ui.gallery([{ url }]), buttons].filter(Boolean);
  const word = kind === 'ED' ? 'ending' : 'opening';
  const lines = list.map((o) => `**${ui.esc(ui.clip(o.song || o.slug, 70))}**${o.artists?.length ? ` — ${ui.esc(ui.clip(o.artists.join(', '), 50))}` : ''}\n-# ${ui.esc(ui.clip(o.animeTitle, 60))} · ${o.slug}`);
  return [ui.text(`${ui.label(`Favorite ${word}${list.length > 1 ? 's' : ''}`)}\n${lines.join('\n')}`), buttons].filter(Boolean);
}

async function overviewBlocks(d) {
  const { u, own } = d;
  const order = (social.LAYOUTS[u.profile.layout] || social.LAYOUTS.classic).order;
  const enabled = new Set(u.profile.sections);
  const blocks = [];
  // Stats live right under the name (if shown at all), not in the section flow.
  if (enabled.has('stats')) blocks.push(...parts.stats(d).filter(Boolean));
  let i = 0;
  for (const key of order) {
    if (key === 'stats' || key === 'bio' || !enabled.has(key)) continue; // both live in the header now
    const comps = parts[key](d).filter(Boolean);
    if (!comps.length) continue;
    // Each section is one unit: if Discord's 40-component limit is hit, whole
    // sections drop from the bottom (they're all on the tabs anyway) instead
    // of the layout losing its spacing. The first section always stays.
    const unit = `sec${i}`;
    const opt = (c) => (i === 0 ? c : ui.optional(c, { priority: 3, unit }));
    blocks.push(i === 0 ? ui.divider() : opt(ui.divider()));
    blocks.push(...comps.map(opt));
    i++;
  }
  if (own && !social.isCustomized(u)) {
    blocks.push(ui.divider());
    blocks.push(ui.text('### ✨ Make this profile yours\n-# Run **/settings** to pick a theme and banner, feature an anime, set your favorite openings and endings, and choose what shows here.'));
  } else if (!blocks.length) {
    blocks.push(ui.text(own ? '*Your profile is empty — add favorites, a featured anime or a bio in `/settings`.*' : '*Nothing to show here yet.*'));
  }
  return blocks;
}

/* --------------------------------- tabs --------------------------------- */

async function tabBlocks(tab, d, page) {
  const { u, s, ownerId, viewerId, own } = d;
  const locked = (what) => [ui.text(`### 🔒 Private\n<@${ownerId}> keeps their ${what} private.`)];

  if (tab === 'favorites') {
    return collections.collectionBlocks(u, 'favorites', { ownerId, page, manage: false, pagerPrefix: `p:t:${ownerId}:favorites` }).concat(
      own ? [ui.actionRow(ui.button('c:v:me:favorites:1:0', 'Reorder & edit', { emoji: '✏️' }))] : []
    );
  }

  if (tab === 'reviews') {
    if (!social.canView(u, viewerId, ownerId, 'reviews')) return locked('reviews');
    const mine = social.reviewsBy(s, ownerId);
    const per = 3;
    const pages = Math.max(1, Math.ceil(mine.length / per));
    page = Math.min(page, pages - 1);
    const slice = mine.slice(page * per, page * per + per);
    const avg = mine.length ? mine.reduce((a, r) => a + r.rating, 0) / mine.length : 0;
    const out = [ui.text(`### ✍️ Reviews · ${mine.length}${mine.length ? `\n-# average score ${avg.toFixed(1)}/10 · ${mine.reduce((a, r) => a + (r.likes?.length || 0), 0)} helpful votes` : ''}`)];
    if (!slice.length) out.push(ui.text(own ? '*No reviews yet — tap ✍️ **Review** on any activity post, or use `/review write`.*' : '*No reviews yet.*'));
    else {
      out.push(...reviews.reviewRows(slice));
      out.push(ui.select(`p:pick:${ownerId}:reviews`, 'Read a review…', slice.map((r) => ({ label: ui.clip(r.title, 100), value: r.id, description: ui.clip(`${r.rating}/10 · ${r.mediaTitle}`, 100) }))));
    }
    if (pages > 1) out.push(pager(ownerId, 'reviews', page, pages));
    return out;
  }

  if (tab === 'recs') {
    if (!social.canView(u, viewerId, ownerId, 'recommendations')) return locked('recommendations');
    const list = u.recommendations;
    const per = 6;
    const pages = Math.max(1, Math.ceil(list.length / per));
    page = Math.min(page, pages - 1);
    const slice = list.slice(page * per, page * per + per);
    const out = [ui.text(`### 💜 Recommends · ${list.length}\n-# ${own ? 'Add a message to any of these with /recommend' : 'Bookmark one to add it to your Watch Later'}`)];
    if (!slice.length) out.push(ui.text(own ? '*Tap 💜 **Recommend** on an activity post, or use `/recommend`.*' : '*No recommendations yet.*'));
    else {
      const g = ui.coverGallery(slice.slice(0, 6).map((e) => ({ url: e.cover, description: e.title })));
      if (g) out.push(g);
      out.push(
        ui.text(
          slice
            .map((e) => {
              const saves = e.bookmarks?.length ? ` · 📌 ${e.bookmarks.length}` : '';
              return `💜 **[${ui.esc(ui.clip(e.title, 60))}](${e.siteUrl})**${saves}${e.message ? `\n> ${ui.softEsc(ui.clip(e.message, 140))}` : ''}`;
            })
            .join('\n')
        )
      );
      if (!own) out.push(ui.select(`p:bm:${ownerId}`, '📌 Bookmark to my Watch Later…', slice.map((e) => ({ label: ui.clip(e.title, 100), value: String(e.mediaId) }))));
    }
    if (pages > 1) out.push(pager(ownerId, 'recs', page, pages));
    return out;
  }

  if (tab === 'collections') {
    if (!social.canView(u, viewerId, ownerId, 'collections')) return locked('collections');
    return collections.homeBlocks(u, { ownerId, viewerId, manage: false });
  }

  if (tab === 'stats') {
    if (!social.canView(u, viewerId, ownerId, 'stats')) return locked('stats');
    const ym = engine.monthKey(engine.dayKey(new Date(), d.tz));
    const out = [...statsUi.streakBlocks(d).slice(0, 3), ui.divider(), ...(await statsUi.monthBlocks(d, ym, { compact: true }))];
    out.push(ui.actionRow(ui.button(`st:v:${ownerId}:month:${ym}`, 'Full stats', { emoji: '📊' }), ui.button(`rc:open:${ownerId}:${ym}`, 'Monthly recap', { emoji: '🎁' })));
    return out;
  }

  if (tab === 'activity') {
    if (!social.canView(u, viewerId, ownerId, 'activity')) return locked('activity');
    if (!d.al) return [ui.text('*No AniList account linked yet.*')];
    let acts = [];
    try {
      acts = await getRecentActivities(d.al.id, 8);
    } catch (e) {
      return [ui.text('⚠️ AniList didn’t answer — try again in a moment.')];
    }
    const lines = acts
      .filter((a) => a.__typename === 'ListActivity' && a.media)
      .slice(0, 8)
      .map((a) => {
        const title = a.media.title?.english || a.media.title?.romaji;
        const status = (a.status || 'updated').replace(/^\w/, (c) => c.toUpperCase());
        return `**${status}${a.progress ? ` ${a.progress}` : ''}** · [${ui.esc(ui.clip(title, 50))}](${a.media.siteUrl})\n-# ${ui.relTime(a.createdAt * 1000)}`;
      });
    const cov = acts.find((a) => a.media?.coverImage)?.media.coverImage;
    const out = [ui.text(`### 📡 Recent activity\n-# Live from AniList`)];
    if (cov) {
      const g = ui.coverGallery(acts.filter((a) => a.media?.coverImage).slice(0, 3).map((a) => ({ url: a.media.coverImage.large || a.media.coverImage.medium, description: a.media.title?.english || a.media.title?.romaji })));
      if (g) out.push(g);
    }
    out.push(ui.text(lines.length ? lines.join('\n') : '*No recent list activity.*'));
    return out;
  }
  return [];
}

function pager(ownerId, tab, page, pages) {
  return ui.actionRow(
    ui.button(`p:t:${ownerId}:${tab}:${Math.max(0, page - 1)}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
    ui.button(`p:noop`, `${page + 1} / ${pages}`, { disabled: true }),
    ui.button(`p:t:${ownerId}:${tab}:${Math.min(pages - 1, page + 1)}`, 'Next', { emoji: '▶️', disabled: page >= pages - 1 })
  );
}

/* --------------------------------- render --------------------------------- */

// userOverride: render from an unsaved draft (settings preview).
async function renderProfile({ ownerId, viewerId, tab = 'overview', page = 0, userOverride = null, previewBanner = null, notice = null }) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const u = userOverride || social.peekUser(s, ownerId);
  const own = ownerId === viewerId;
  const pal = paletteFor(u.profile);
  const user = await discordUser(ownerId);
  const al = social.anilistFor(core, ownerId);

  if (!own && u.privacy.profile === 'private') {
    return ui.fit([ui.card(pal.accent, [header(u, user, null, pal), ui.divider(), ui.text('🔒 This profile is private.')])]);
  }

  let snap = null;
  let rotation = null;
  if (al) {
    if (tab === 'overview' || tab === 'stats') snap = await getProfileSnapshot(al.id).catch(() => null);
    if (tab === 'overview' && u.profile.sections.includes('rotation')) {
      rotation = (await collections.rotationEntries(u, al.id).catch(() => ({ all: [] }))).all;
    }
  } else if (tab === 'overview' && u.profile.sections.includes('rotation')) {
    rotation = (await collections.rotationEntries(u, null).catch(() => ({ all: [] }))).all;
  }
  // Featured anime banner (older saves don't have it stored — look it up).
  let featuredBanner = null;
  const f = u.profile.featured;
  let featuredMedia = null;
  if (tab === 'overview' && f && u.profile.sections.includes('featured')) {
    featuredMedia = (await getMediaBatch([f.mediaId]).catch(() => new Map())).get(Number(f.mediaId)) || null;
    featuredBanner = f.banner || featuredMedia?.bannerImage || (await getMediaLite(f.mediaId).catch(() => null))?.bannerImage || null;
  }
  const su = al ? st.users[String(al.id)] : null;
  const d = { core, s, st, u, own, ownerId, viewerId, pal, user, al, snap, su, tz: u.prefs.timezone || social.DEFAULT_TZ, rotation, featuredBanner, featuredMedia };

  const children = [];
  if (notice) children.push(ui.text(notice));
  if (tab === 'overview') {
    // Painted / featured banners come back as one image with the avatar
    // overlapping the banner's bottom edge. Custom images (incl. GIFs) are
    // shown untouched, with the avatar beside the name instead.
    const headerImg = previewBanner === null ? headerUrlFor(u.profile, user) : null;
    const banner = headerImg || (previewBanner !== null ? previewBanner : bannerUrlFor(u.profile));
    const g = banner ? ui.gallery([{ url: banner, description: 'Profile banner' }]) : null;
    if (g) children.push(g);
    children.push(header(u, user, al, pal, { avatarInImage: Boolean(headerImg && g), ownerId }));
    if (headerImg && user) warmHeader(u.profile, user);
    children.push(...(await overviewBlocks(d)));
  } else {
    children.push(ui.text(`-# ${ui.esc(u.profile.displayName || user?.globalName || user?.username || 'Profile')}  ›  ${TABS[tab]?.label.toUpperCase() || ''}`));
    children.push(...(await tabBlocks(tab, d, page)));
  }
  children.push(ui.divider());
  children.push(...navRows(ownerId, tab));
  const payload = ui.fit([ui.card(pal.accent, children)]);
  // Paint the cards before Discord asks for them (and retry any cover that
  // failed), so no image shows up blank.
  await artRoutes.warmPayload(payload, 6000);
  return payload;
}

/* -------------------------------- handlers -------------------------------- */

async function handleCommand(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  if (target.bot) return ctx.respond(interaction, { content: 'Bots don’t have anime profiles (yet) 🤖', flags: ui.EPHEMERAL });
  await interaction.deferReply().catch(() => {});
  const s = await ctx.loadSocial();
  if (target.id === interaction.user.id) {
    social.markGuild(social.getUser(s, interaction.user.id), interaction.guildId);
    ctx.saveSocial();
  }
  const payload = await renderProfile({ ownerId: target.id, viewerId: interaction.user.id });
  return ctx.respond(interaction, payload);
}

async function showView(interaction, payload) {
  const invoker = interaction.message?.interactionMetadata?.user?.id;
  const isPublic = interaction.message && !interaction.message.flags?.has?.(ui.EPHEMERAL);
  try {
    if (isPublic && invoker && invoker !== interaction.user.id) {
      await interaction.deferReply({ flags: ui.EPHEMERAL });
      await interaction.editReply(await payload());
    } else {
      await interaction.deferUpdate();
      await interaction.editReply(await payload());
    }
  } catch (e) {
    console.error('Profile view failed:', e.message);
  }
}

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const me = interaction.user.id;
  if (action === 'noop') return interaction.deferUpdate().catch(() => {});

  if (action === 't') {
    const [, , owner, tab, page] = parts;
    return showView(interaction, () => renderProfile({ ownerId: owner, viewerId: me, tab, page: parseInt(page, 10) || 0 }));
  }

  if (action === 'pick') {
    const tab = parts[3];
    const s = await ctx.loadSocial();
    if (tab === 'reviews') {
      const r = s.reviews[interaction.values[0]];
      if (!r) return interaction.reply({ content: 'That review was deleted.', flags: ui.EPHEMERAL }).catch(() => {});
      return interaction
        .reply({ ...reviews.reviewCard(r, social.peekUser(s, r.authorId), { mode: r.authorId === me ? 'author' : 'reader' }), flags: ui.V2 | ui.EPHEMERAL })
        .catch((e) => console.error(e.message));
    }
  }

  if (action === 'bm') {
    const [, , owner] = parts;
    const s = await ctx.loadSocial();
    const ownerU = social.peekUser(s, owner);
    const rec = ownerU.recommendations.find((e) => e.mediaId === parseInt(interaction.values[0], 10));
    if (!rec) return interaction.reply({ content: 'That recommendation is gone.', flags: ui.EPHEMERAL }).catch(() => {});
    const mine = social.getUser(s, me);
    const res = social.addItem(mine.watchlist, { mediaId: rec.mediaId, title: rec.title, cover: rec.cover, siteUrl: rec.siteUrl }, 'watchlist', { via: owner });
    if (res.ok && s.users[owner]) {
      const r2 = s.users[owner].recommendations.find((e) => e.mediaId === rec.mediaId);
      if (r2) r2.bookmarks = [...new Set([...(r2.bookmarks || []), me])];
    }
    social.markGuild(mine, interaction.guildId);
    await ctx.saveSocial();
    return interaction
      .reply({
        content: res.ok ? `📌 Saved **${rec.title}** to your Watch Later (thanks to <@${owner}>).` : res.reason === 'exists' ? 'It’s already in your Watch Later.' : 'Your Watch Later is full.',
        flags: ui.EPHEMERAL,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
}

module.exports = { renderProfile, handleCommand, onComponent, TABS };
