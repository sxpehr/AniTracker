const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const { ctx } = require('./ctx');
const { searchAnime, titleOf, getMediaLite, snapshot } = require('./anilistSocial');
const profile = require('./profile');
const settings = require('./settings');
const collections = require('./collections');
const reviews = require('./reviews');
const statsUi = require('./statsUi');
const anime = require('./anime');

/* Slash commands for the profile / collections / reviews / stats features,
   plus autocomplete for anime names, collections and months. */

function describe(m) {
  return [m.seasonYear, m.format && m.format.replace('_', ' ')].filter(Boolean).join(' · ');
}

async function withTimeout(promise, ms, fallback) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const value = String(focused.value || '');
  let choices = [];
  try {
    const sub = interaction.options.getSubcommand(false);
    if (focused.name === 'anime' && sub === 'remove' && ['watchlater', 'myfavorites', 'rotation'].includes(interaction.commandName)) {
      choices = await anime.listSuggestions(interaction, value);
    } else if (focused.name === 'anime' && ['watched', 'ratings'].includes(interaction.commandName) && value.trim().length < 2) {
      choices = await require('./watched').suggestions(interaction.guildId, value);
    } else if (focused.name === 'anime') {
      if (value.trim().length >= 2) {
        const results = await withTimeout(searchAnime(value, 10), 2500, []);
        choices = results.map((m) => {
          reviews.rememberTitle(m.id, titleOf(m));
          const extra = describe(m);
          return { name: ui.clip(`${titleOf(m)}${extra ? ` (${extra})` : ''}`, 100), value: String(m.id) };
        });
      }
    } else if (focused.name === 'collection') {
      const s = await ctx.loadSocial();
      const target = interaction.options.get('user')?.value || interaction.user.id;
      const u = social.peekUser(s, target);
      const all = [
        { name: '⭐ Favorites', value: 'favorites' },
        { name: '📌 Watch Later', value: 'watchlist' },
        { name: '💜 Recommendations', value: 'recommendations' },
        ...(interaction.options.getSubcommand(false) === 'view' ? [{ name: '🔄 In Rotation', value: 'rotation' }] : []),
        ...u.collections.filter((c) => target === interaction.user.id || c.visibility !== 'private').map((c) => ({ name: ui.clip(`${c.emoji || '🗂️'} ${c.name}`, 100), value: c.id })),
      ];
      choices = all.filter((c) => c.name.toLowerCase().includes(value.toLowerCase()));
    } else if (focused.name === 'month') {
      const core = await ctx.loadData();
      const st = await ctx.loadStats();
      const s = await ctx.loadSocial();
      const target = interaction.options.get('user')?.value || interaction.user.id;
      const al = social.anilistFor(core, target);
      const tz = social.peekUser(s, target).prefs.timezone;
      const current = engine.monthKey(engine.dayKey(new Date(), tz));
      // Always the last 6 months (no typing needed), plus older months with data.
      const history = st.users[String(al?.id)]?.months || {};
      const recent = engine.lastMonths(current, 6).reverse();
      const older = Object.keys(history)
        .filter((m) => !recent.includes(m))
        .sort()
        .reverse();
      choices = [...recent, ...older]
        .slice(0, 25)
        .map((m, i) => {
          const eps = history[m]?.e || 0;
          const when = i === 0 ? 'This month' : i === 1 ? 'Last month' : null;
          return { name: `${engine.monthName(m)}${when ? ` · ${when}` : ''}${eps ? ` · ${eps} eps` : ' · nothing logged'}`, value: m };
        })
        .filter((c) => c.name.toLowerCase().includes(value.toLowerCase()));
    }
  } catch (e) {
    console.error('Autocomplete failed:', e.message);
  }
  return interaction.respond(choices.slice(0, 25)).catch(() => {});
}

function animeIdFrom(interaction) {
  const raw = interaction.options.getString('anime');
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && String(id) === String(raw).trim() ? id : null;
}

async function resolveAnime(interaction) {
  let id = animeIdFrom(interaction);
  if (id) return getMediaLite(id).catch(() => null);
  // typed text without picking a suggestion: take the best match
  const results = await searchAnime(interaction.options.getString('anime'), 1).catch(() => []);
  return results[0] || null;
}

async function handle(interaction) {
  const name = interaction.commandName;
  const me = interaction.user.id;

  if (name === 'profile') return profile.handleCommand(interaction);
  if (name === 'settings') return settings.handleCommand(interaction);

  if (name === 'watchlater' || name === 'myfavorites' || name === 'rotation') return anime.handleListCommand(interaction);
  if (name === 'anime') return anime.handleCommand(interaction);

  if (name === 'collection') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'view') {
      const target = interaction.options.getUser('user') || interaction.user;
      const key = interaction.options.getString('collection') || 'home';
      const own = target.id === me;
      await interaction.deferReply({ flags: own ? ui.EPHEMERAL : 0 }).catch(() => {});
      return ctx.respond(interaction, await collections.viewPayload({ ownerId: target.id, viewerId: me, key, manage: own }));
    }
    if (sub === 'manage') {
      return ctx.respond(interaction, { ...(await collections.viewPayload({ ownerId: me, viewerId: me, key: 'home', manage: true })), flags: ui.V2 | ui.EPHEMERAL });
    }
    if (sub === 'create') return interaction.showModal(collections.collectionModal('c:m:new', 'New collection'));
    if (sub === 'add') {
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      const media = await resolveAnime(interaction);
      if (!media) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList.' });
      const s = await ctx.loadSocial();
      const u = social.getUser(s, me);
      const key = interaction.options.getString('collection');
      if (!key) return ctx.respond(interaction, collections.saveToPayload(u, media));
      const r = social.getList(u, key);
      if (!r) return ctx.respond(interaction, { content: 'Pick one of your collections from the list.' });
      const res = social.addItem(r.list, snapshot(media), key);
      social.markGuild(u, interaction.guildId);
      await ctx.saveSocial();
      const msg = res.ok ? `✅ Added **${titleOf(media)}** to **${r.meta.name}**.` : res.reason === 'exists' ? `It’s already in **${r.meta.name}**.` : `**${r.meta.name}** is full.`;
      return ctx.respond(interaction, { content: msg });
    }
  }

  if (name === 'recommend') {
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    const media = await resolveAnime(interaction);
    if (!media) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList.' });
    const message = (interaction.options.getString('message') || '').trim() || undefined;
    const s = await ctx.loadSocial();
    const u = social.getUser(s, me);
    const existing = u.recommendations.find((e) => e.mediaId === media.id);
    if (existing) {
      if (message) existing.message = message;
    } else {
      const res = social.addItem(u.recommendations, snapshot(media), 'recommendations', message ? { message } : {});
      if (!res.ok) return ctx.respond(interaction, { content: 'Your recommendations list is full (100). Remove some in `/collection manage`.' });
    }
    social.markGuild(u, interaction.guildId);
    await ctx.saveSocial();
    if (ctx.applyRecommendVote) await ctx.applyRecommendVote(interaction.guildId, me, media, true);
    const snap = snapshot(media);
    return ctx.respond(
      interaction,
      ui.fit([
        ui.card(ui.ANILIST_BLUE, [
          ui.row([`-# 💜 RECOMMENDED`, `### ${ui.esc(snap.title)}`, message ? `> ${ui.softEsc(message)}` : '-# Add a message any time with /recommend or from your lists'], snap.cover),
          ui.actionRow(
            ui.button(`c:note:recommendations:${media.id}`, message ? 'Edit message' : 'Add a message', { emoji: '✏️' }),
            ui.button(`p:t:${me}:recs:0`, 'See my recommendations', { emoji: '💜' })
          ),
        ]),
      ])
    );
  }

  if (name === 'review') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'write') {
      const id = animeIdFrom(interaction);
      if (id) return reviews.openWriteForm(interaction, id);
      // Modals must be the first response — if they typed a name without picking, ask them to pick.
      return ctx.respond(interaction, { content: 'Pick the anime from the suggestions that pop up while you type, then run it again.', flags: ui.EPHEMERAL });
    }
    const s = await ctx.loadSocial();
    if (sub === 'read') {
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      const media = await resolveAnime(interaction);
      return ctx.respond(interaction, reviews.browsePayload(s, { sort: 'liked', viewerId: me, guildId: interaction.guildId, mediaId: media?.id || -1 }));
    }
    if (sub === 'browse') {
      const sort = interaction.options.getString('sort') || 'recent';
      return ctx.respond(interaction, { ...reviews.browsePayload(s, { sort, viewerId: me, guildId: interaction.guildId }), flags: ui.V2 | ui.EPHEMERAL });
    }
  }

  if (name === 'stats') {
    const target = interaction.options.getUser('user') || interaction.user;
    await interaction.deferReply().catch(() => {});
    return ctx.respond(interaction, await statsUi.statsPayload(target.id, me, 'month'));
  }

  if (name === 'recap') {
    const target = interaction.options.getUser('user') || interaction.user;
    const priv = interaction.options.getBoolean('private') ?? false;
    const s = await ctx.loadSocial();
    const tz = social.peekUser(s, target.id).prefs.timezone;
    let ym = interaction.options.getString('month');
    if (!/^\d{4}-\d{2}$/.test(ym || '')) ym = engine.monthKey(engine.dayKey(new Date(), tz));
    await interaction.deferReply(priv ? { flags: ui.EPHEMERAL } : {}).catch(() => {});
    const { personalRecap } = require('./recaps');
    return ctx.respond(interaction, await personalRecap(target.id, me, ym, { shareable: priv }));
  }

  if (name === 'rate') {
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    const media = await resolveAnime(interaction);
    if (media) require('./ratings').rememberTitle(media.id, titleOf(media));
    return require('./ratings').handleRate(interaction, media, interaction.options.getInteger('score'), (interaction.options.getString('note') || '').trim() || null);
  }

  if (name === 'ratings') {
    await interaction.deferReply().catch(() => {});
    const user = interaction.options.getUser('user');
    let mediaId = null;
    if (interaction.options.getString('anime')) mediaId = animeIdFrom(interaction) || (await resolveAnime(interaction))?.id || -1;
    return require('./ratings').handleRatings(interaction, { user, mediaId });
  }

  if (name === 'watched') {
    await interaction.deferReply().catch(() => {});
    const user = interaction.options.getUser('user');
    let mediaId = null;
    if (interaction.options.getString('anime')) mediaId = animeIdFrom(interaction) || (await resolveAnime(interaction))?.id || -1;
    return require('./watched').handleCommand(interaction, { mediaId, user, query: interaction.options.getString('search') });
  }

  if (name === 'leaderboard') {
    const board = interaction.options.getString('category') || 'episodes';
    await interaction.deferReply().catch(() => {});
    return ctx.respond(interaction, await statsUi.leaderboardPayload(interaction.guildId, board));
  }
}

const HANDLED = new Set(['anime', 'rotation', 'profile', 'settings', 'watchlater', 'myfavorites', 'collection', 'recommend', 'review', 'stats', 'recap', 'leaderboard', 'rate', 'ratings', 'watched']);

module.exports = { handle, autocomplete, HANDLED };
