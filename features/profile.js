const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const collections = require('./collections');
const reviews = require('./reviews');
const statsUi = require('./statsUi');
const { paletteFor, bannerUrlFor } = require('./themes');
const { ctx } = require('./ctx');
const { getProfileSnapshot } = require('./anilistSocial');
const { getRecentActivities } = require('../anilist');

/* ---------------------------------------------------------------------------
 * /profile — a personal anime page, built as an interactive card.
 *
 *   Overview | Favorites | Reviews | Recs | Collections | Stats | Activity
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
  overview: { label: 'Overview', emoji: '🪪' },
  favorites: { label: 'Favorites', emoji: '⭐' },
  reviews: { label: 'Reviews', emoji: '✍️' },
  recs: { label: 'Recs', emoji: '💜' },
  collections: { label: 'Collections', emoji: '🗂️' },
  stats: { label: 'Stats', emoji: '📊' },
  activity: { label: 'Activity', emoji: '📡' },
};

function navRows(ownerId, tab, { own, anilistUrl }) {
  const b = (t) =>
    ui.button(`p:t:${ownerId}:${t}:0:n`, TABS[t].label, { emoji: TABS[t].emoji, style: t === tab ? ui.ButtonStyle.Primary : ui.ButtonStyle.Secondary });
  const row2 = [b('collections'), b('stats'), b('activity')];
  if (own) row2.push(ui.button('s:open', 'Customize', { emoji: '🎨', style: ui.ButtonStyle.Success }));
  else if (anilistUrl) row2.push(ui.linkButton(anilistUrl, 'AniList', '🔗'));
  return [ui.actionRow(b('overview'), b('favorites'), b('reviews'), b('recs')), ui.actionRow(row2)];
}

async function discordUser(id) {
  try {
    return ctx.client.users.cache.get(id) || (await ctx.client.users.fetch(id));
  } catch {
    return null;
  }
}

function header(u, user, al, pal) {
  const name = u.profile.displayName || user?.globalName || user?.username || 'Unknown';
  const handle = user?.username ? `@${user.username}` : '';
  const sub = [handle, al ? `[AniList](${al.siteUrl})` : null, `${pal.name} theme`].filter(Boolean).join('  ·  ');
  const lines = [`## ${ui.esc(name)}`, `-# ${sub}`];
  if (u.profile.tagline) lines.push(`*${ui.softEsc(u.profile.tagline)}*`);
  return ui.row(lines, user?.displayAvatarURL?.({ size: 256, extension: 'png' }));
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

  featured: ({ u }) => {
    const f = u.profile.featured;
    if (!f) return [];
    const meta = [f.year, f.format && f.format.replace('_', ' '), f.episodes ? `${f.episodes} episodes` : null].filter(Boolean).join(' · ');
    const lines = [ui.label('Featured'), `### [${ui.esc(ui.clip(f.title, 80))}](${f.siteUrl})`];
    lines.push([meta ? `-# ${meta}` : null, f.note ? `> ${ui.softEsc(ui.clip(f.note, 200))}` : null].filter(Boolean).join('\n') || '-# ✦');
    return [ui.row(lines, f.cover)];
  },

  favorites: ({ u }) => {
    if (!u.favorites.length) return [];
    const top = u.favorites.slice(0, 4);
    const out = [ui.text(`${ui.label(`Favorites · ${u.favorites.length}`)}`)];
    const g = ui.coverGallery(top.map((e) => ({ url: e.cover, description: e.title })), { single: 'row' });
    if (g) out.push(g);
    out.push(ui.optional(ui.text(`-# ${top.map((e) => ui.esc(ui.clip(e.title, 30))).join('  ·  ')}${u.favorites.length > 4 ? `  ·  +${u.favorites.length - 4} more` : ''}`), { priority: 1 }));
    return out;
  },

  rotation: ({ rotation }) => {
    if (!rotation?.length) return [];
    const top = rotation.slice(0, 3);
    const lines = top.map((e) => {
      const title = `**[${ui.esc(ui.clip(e.title, 40))}](${e.siteUrl})**`;
      if (e.progress === null) return `${e.pinned ? '📌 ' : ''}${title}`;
      if (e.total) return `${e.pinned ? '📌 ' : ''}${title}\n${ui.bar(e.progress, e.total, 12)}  \`${e.progress}/${e.total}\``;
      return `${e.pinned ? '📌 ' : ''}${title}\n-# episode ${e.progress}${e.next ? ` · ep ${e.next.episode} ${ui.relTime(e.next.airingAt * 1000)}` : ''}`;
    });
    return [ui.text(`${ui.label(`In Rotation · ${rotation.length}`)}\n${lines.join('\n')}`)];
  },

  opening: ({ u }) => {
    const o = u.profile.opening;
    if (!o) return [];
    const who = o.artists?.length ? ` — ${ui.esc(ui.clip(o.artists.join(', '), 60))}` : '';
    const link = o.videoUrl || o.pageUrl || `https://www.youtube.com/results?search_query=${encodeURIComponent(`${o.animeTitle} ${o.slug} ${o.song || ''}`)}`;
    return [
      ui.row(
        [ui.label('Favorite opening'), `### 🎵 ${ui.esc(ui.clip(o.song || o.slug, 70))}${who}`, `-# ${ui.esc(ui.clip(o.animeTitle, 60))} · ${o.slug}${o.episodes ? ` · eps ${o.episodes}` : ''}`],
        ui.linkButton(link, 'Play', '▶️')
      ),
    ];
  },

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

async function overviewBlocks(d) {
  const { u, own } = d;
  const order = (social.LAYOUTS[u.profile.layout] || social.LAYOUTS.classic).order;
  const enabled = new Set(u.profile.sections);
  const blocks = [];
  let i = 0;
  for (const key of order) {
    if (!enabled.has(key)) continue;
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
    blocks.push(
      ui.section(
        ['### ✨ Make this profile yours', '-# Pick a theme and banner, feature an anime, set your favorite opening and choose what shows here. Takes a minute.'],
        ui.button('s:open:cta', 'Start', { emoji: '🎨', style: ui.ButtonStyle.Primary })
      )
    );
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
  const su = al ? st.users[String(al.id)] : null;
  const d = { core, s, st, u, own, ownerId, viewerId, pal, user, al, snap, su, tz: u.prefs.timezone || social.DEFAULT_TZ, rotation };

  const children = [];
  if (notice) children.push(ui.text(notice));
  if (tab === 'overview') {
    const banner = previewBanner !== null ? previewBanner : bannerUrlFor(u.profile);
    const g = banner ? ui.gallery([{ url: banner, description: 'Profile banner' }]) : null;
    if (g) children.push(g);
    children.push(header(u, user, al, pal));
    children.push(...(await overviewBlocks(d)));
  } else {
    children.push(ui.text(`-# ${ui.esc(u.profile.displayName || user?.globalName || user?.username || 'Profile')}  ›  ${TABS[tab]?.label.toUpperCase() || ''}`));
    children.push(...(await tabBlocks(tab, d, page)));
  }
  children.push(ui.divider());
  children.push(...navRows(ownerId, tab, { own, anilistUrl: al?.siteUrl }));
  return ui.fit([ui.card(pal.accent, children)]);
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
      await interaction.reply({ ...(await payload()), flags: ui.V2 | ui.EPHEMERAL });
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
