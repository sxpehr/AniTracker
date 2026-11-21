const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { ctx } = require('./ctx');
const { searchAnime, getMediaLite, getTrending, getRandomAnime, snapshot, titleOf } = require('./anilistSocial');
const collections = require('./collections');

/* ---------------------------------------------------------------------------
 * /anime — look anything up and act on it.
 *   /anime info · search · trending · random · airing
 *
 * Every info card has quick actions: Watch later · Favorite · Rotation ·
 * Review · Lists.
 *
 * ids:  a:open (menu) · a:wl:<id> · a:fav:<id> · a:rot:<id>
 * ------------------------------------------------------------------------- */

function actionRow(mediaId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`a:wl:${mediaId}`).setLabel('Watch later').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`a:fav:${mediaId}`).setLabel('Favorite').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`a:rot:${mediaId}`).setLabel('Rotation').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rvw_${mediaId}`).setLabel('Review').setEmoji('✍️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`col_${mediaId}`).setLabel('Lists').setEmoji('🗂️').setStyle(ButtonStyle.Secondary)
  );
}

async function infoPayload(mediaId, { lead } = {}) {
  const payload = ctx.buildMoreInfoPayload ? await ctx.buildMoreInfoPayload(mediaId, { actions: actionRow(mediaId), footer: 'Data from AniList', lead }) : null;
  return payload || null;
}

function describe(m) {
  return [m.seasonYear, m.format && m.format.replace('_', ' '), m.episodes ? `${m.episodes} eps` : null, m.averageScore ? `★ ${(m.averageScore / 10).toFixed(1)}` : null]
    .filter(Boolean)
    .join(' · ');
}

// A browsable list (search results, trending): covers + numbered lines + "open" menu.
function listPayload(title, subtitle, list) {
  const children = [ui.text(`### ${title}\n-# ${subtitle}`)];
  if (!list.length) children.push(ui.text('*Nothing found — try another spelling, or the English/Japanese title.*'));
  else {
    const g = ui.coverGallery(list.slice(0, 6).map((m) => ({ url: m.coverImage?.extraLarge || m.coverImage?.large, description: titleOf(m) })));
    if (g) children.push(g);
    children.push(
      ui.text(
        list
          .slice(0, 10)
          .map((m, i) => `\`${String(i + 1).padStart(2, '0')}\` **[${ui.esc(ui.clip(titleOf(m), 60))}](${m.siteUrl})**\n-# ${describe(m) || 'AniList'}`)
          .join('\n')
      )
    );
    children.push(ui.select('a:open', 'Open one for details & actions…', list.slice(0, 25).map((m) => ({ label: ui.clip(titleOf(m), 100), value: String(m.id), description: ui.clip(describe(m) || 'AniList', 100) }))));
  }
  return ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
}

async function resolve(interaction, optName = 'anime') {
  const raw = interaction.options.getString(optName);
  const id = parseInt(raw, 10);
  if (Number.isFinite(id) && String(id) === String(raw).trim()) return getMediaLite(id).catch(() => null);
  return (await searchAnime(raw, 1).catch(() => []))[0] || null;
}

const AL_DOWN = '⚠️ AniList isn’t responding right now (their side). Try again in a bit.';

/* -------------------------------- commands -------------------------------- */

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const share = interaction.options.getBoolean('share') ?? false;
  await interaction.deferReply(share ? {} : { flags: ui.EPHEMERAL }).catch(() => {});

  if (sub === 'info') {
    const media = await resolve(interaction);
    if (!media) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList.' });
    return ctx.respond(interaction, (await infoPayload(media.id)) || { content: AL_DOWN });
  }
  if (sub === 'search') {
    const q = interaction.options.getString('query');
    const list = await searchAnime(q, 15).catch(() => null);
    if (!list) return ctx.respond(interaction, { content: AL_DOWN });
    return ctx.respond(interaction, listPayload(`🔎 “${ui.esc(ui.clip(q, 60))}”`, `${list.length} result${list.length === 1 ? '' : 's'} on AniList`, list));
  }
  if (sub === 'trending') {
    const sort = interaction.options.getString('sort') || 'TRENDING_DESC';
    const list = await getTrending(15, sort).catch(() => null);
    if (!list) return ctx.respond(interaction, { content: AL_DOWN });
    const label = { TRENDING_DESC: '🔥 Trending right now', POPULARITY_DESC: '❤️ Most popular ever', SCORE_DESC: '🏆 Highest rated ever' }[sort] || '🔥 Trending';
    return ctx.respond(interaction, listPayload(label, 'Live from AniList', list));
  }
  if (sub === 'random') {
    const id = await getRandomAnime(interaction.options.getString('genre'), false, interaction.options.getString('vibe')).catch(() => null);
    if (!id) return ctx.respond(interaction, { content: AL_DOWN });
    const payload = await infoPayload(id, { lead: '### 🎲 How about this one?' });
    if (!payload) return ctx.respond(interaction, { content: AL_DOWN });
    return ctx.respond(interaction, payload);
  }
  if (sub === 'airing') {
    const core = await ctx.loadData();
    const s = await ctx.loadSocial();
    const u = social.peekUser(s, interaction.user.id);
    const al = social.anilistFor(core, interaction.user.id);
    const { all } = await collections.rotationEntries(u, al?.id).catch(() => ({ all: [] }));
    const airing = all.filter((e) => e.next).sort((a, b) => a.next.airingAt - b.next.airingAt);
    const children = [ui.text('### 📅 Up next\n-# Next episodes of the shows in your rotation')];
    if (!airing.length) children.push(ui.text(al ? '*Nothing in your rotation is currently airing.*' : '*Link your AniList with `/signin` (or add shows with `/rotation add`) to see what’s airing next.*'));
    else
      children.push(
        ...airing.slice(0, 8).map((e) =>
          ui.row([`**[${ui.esc(ui.clip(e.title, 60))}](${e.siteUrl})**`, `-# Episode **${e.next.episode}** ${ui.relTime(e.next.airingAt * 1000)} · <t:${e.next.airingAt}:f>`], e.cover)
        )
      );
    return ctx.respond(interaction, ui.fit([ui.card(ui.ANILIST_BLUE, children)]));
  }
}

// /watchlater · /myfavorites · /rotation  (view | add | remove)
async function handleListCommand(interaction) {
  const name = interaction.commandName;
  const sub = interaction.options.getSubcommand();
  const me = interaction.user.id;
  const key = name === 'watchlater' ? 'watchlist' : name === 'myfavorites' ? 'favorites' : 'rotation';

  if (sub === 'view') {
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    return ctx.respond(interaction, await collections.viewPayload({ ownerId: me, viewerId: me, key, manage: true }));
  }

  await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
  const s = await ctx.loadSocial();
  const u = social.getUser(s, me);
  social.markGuild(u, interaction.guildId);

  if (key === 'rotation') {
    if (sub === 'add') {
      const media = await resolve(interaction);
      if (!media) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList.' });
      if (!u.rotation.extra.some((x) => x.mediaId === media.id)) u.rotation.extra.push(snapshot(media));
      u.rotation.hidden = u.rotation.hidden.filter((id) => id !== media.id);
      await ctx.saveSocial();
      return ctx.respond(interaction, { content: `🔄 Added **${titleOf(media)}** to your rotation.` });
    }
    if (sub === 'remove') {
      const id = parseInt(interaction.options.getString('anime'), 10);
      if (!id) return ctx.respond(interaction, { content: 'Pick a show from the suggestions.' });
      const titles = await collections.rotationTitles(u, me);
      const [name2] = collections.removeFromRotation(u, [id], titles);
      await ctx.saveSocial();
      return ctx.respond(interaction, { content: `➖ Removed **${name2}** from your rotation.${u.rotation.extra.some((x) => x.mediaId === id) ? '' : ' (Your AniList list isn’t changed — bring it back any time in `/rotation view`.)'}` });
    }
  }

  const list = u[key];
  const label = key === 'watchlist' ? 'Watch Later' : 'Favorites';
  if (sub === 'add') {
    const media = await resolve(interaction);
    if (!media) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList.' });
    const note = (interaction.options.getString('note') || '').trim() || undefined;
    const res = social.addItem(list, snapshot(media), key, note ? { note } : {});
    await ctx.saveSocial();
    if (!res.ok) return ctx.respond(interaction, { content: res.reason === 'exists' ? `**${titleOf(media)}** is already in your ${label}.` : `Your ${label} is full.` });
    return ctx.respond(interaction, { content: `${key === 'watchlist' ? '📌' : '⭐'} Added **${titleOf(media)}** to your ${label} (#${list.length}).` });
  }
  if (sub === 'remove') {
    const id = parseInt(interaction.options.getString('anime'), 10);
    const removed = id ? social.removeItem(list, id) : null;
    await ctx.saveSocial();
    return ctx.respond(interaction, { content: removed ? `🗑️ Removed **${removed.title}** from your ${label}.` : `That isn’t in your ${label} — pick one from the suggestions.` });
  }
}

/* ------------------------------- components ------------------------------- */

async function onComponent(interaction) {
  const [, action, idStr] = interaction.customId.split(':');
  if (action === 'open') {
    await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
    const payload = await infoPayload(parseInt(interaction.values[0], 10));
    return ctx.respond(interaction, payload || { content: AL_DOWN });
  }
  const mediaId = parseInt(idStr, 10);
  if (!mediaId) return;
  await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
  if (action === 'wl') return ctx.toggleList(interaction, mediaId, 'watchlist');
  if (action === 'fav') return ctx.toggleList(interaction, mediaId, 'favorites');
  if (action === 'rot') {
    const media = await getMediaLite(mediaId).catch(() => null);
    if (!media) return ctx.respond(interaction, { content: AL_DOWN });
    const s = await ctx.loadSocial();
    const u = social.getUser(s, interaction.user.id);
    const there = u.rotation.extra.some((x) => x.mediaId === mediaId);
    if (there) u.rotation.extra = u.rotation.extra.filter((x) => x.mediaId !== mediaId);
    else {
      u.rotation.extra.push(snapshot(media));
      u.rotation.hidden = u.rotation.hidden.filter((id) => id !== mediaId);
    }
    await ctx.saveSocial();
    return ctx.respond(interaction, { content: there ? `➖ Removed **${titleOf(media)}** from your rotation.` : `🔄 Added **${titleOf(media)}** to your rotation — see it with \`/rotation view\`.` });
  }
}

// Autocomplete for "remove" subcommands: suggest what's actually in the list.
async function listSuggestions(interaction, value) {
  const name = interaction.commandName;
  const s = await ctx.loadSocial();
  const u = social.peekUser(s, interaction.user.id);
  let items = [];
  if (name === 'watchlater') items = u.watchlist;
  else if (name === 'myfavorites') items = u.favorites;
  else if (name === 'rotation') {
    const titles = await collections.rotationTitles(u, interaction.user.id).catch(() => ({}));
    items = Object.entries(titles).map(([id, title]) => ({ mediaId: Number(id), title }));
  }
  return items
    .filter((e) => e.title.toLowerCase().includes(value.toLowerCase()))
    .slice(0, 25)
    .map((e) => ({ name: ui.clip(e.title, 100), value: String(e.mediaId) }));
}

module.exports = { handleCommand, handleListCommand, onComponent, listSuggestions, infoPayload };
