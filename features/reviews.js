const { ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, StringSelectMenuBuilder, TextDisplayBuilder } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { paletteFor } = require('./themes');
const { ctx } = require('./ctx');
const { getMediaLite, snapshot } = require('./anilistSocial');

/* ---------------------------------------------------------------------------
 * Reviews — written in Discord, kept in AniTracker (separate from AniList
 * scores, which are never treated as reviews).
 *
 * ids:
 *   rv:write:<mediaId>          open the review form (button on activity posts)
 *   rv:m:<mediaId>              form submit (create or edit)
 *   rv:open:<reviewId>          full review (ephemeral)
 *   rv:like:<reviewId>:<p|e>    helpful toggle (p = on a public card)
 *   rv:edit:<reviewId> / rv:del:<reviewId> / rv:delok:<reviewId>
 *   rv:share:<reviewId>         post the card in the channel
 *   rv:feat:<reviewId>          feature on profile
 *   rv:b:<sort>:<page>[:<mediaId>]   browse
 *   rv:bs                       sort menu
 *   rv:pick:<sort>:<page>[:<mediaId>] read one from the list
 * ------------------------------------------------------------------------- */

const SCORE_LABELS = { 10: 'Masterpiece', 9: 'Amazing', 8: 'Great', 7: 'Good', 6: 'Fine', 5: 'Average', 4: 'Bad', 3: 'Very bad', 2: 'Horrible', 1: 'Appalling' };
const SORTS = {
  recent: { label: 'Newest', emoji: '🆕', description: 'Recently published' },
  liked: { label: 'Most helpful', emoji: '❤️', description: 'Most liked reviews' },
  rating: { label: 'Highest rated', emoji: '🏆', description: 'Top scores first' },
  server: { label: 'This server', emoji: '🏠', description: 'Reviews by people here' },
  mine: { label: 'My reviews', emoji: '✍️', description: 'Everything you wrote' },
};
const PER_PAGE = 3;
const titleCache = new Map(); // mediaId -> title (for form titles, filled by autocomplete/search)

function rememberTitle(id, title) {
  titleCache.set(Number(id), title);
  if (titleCache.size > 2000) titleCache.delete(titleCache.keys().next().value);
}

function reviewModal(mediaId, mediaTitle, existing, spoilerDefault = false) {
  const rating = new StringSelectMenuBuilder()
    .setCustomId('rating')
    .setRequired(true)
    .setPlaceholder('Your score')
    .addOptions(
      Object.entries(SCORE_LABELS)
        .sort((a, b) => b[0] - a[0])
        .map(([v, l]) => ({ label: `${v}/10 — ${l}`, value: v, description: ui.stars10(Number(v)), default: existing?.rating === Number(v) }))
    );
  const title = new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(100).setRequired(true).setPlaceholder('A headline for your review');
  if (existing?.title) title.setValue(existing.title);
  const content = new TextInputBuilder()
    .setCustomId('content')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(30)
    .setMaxLength(2000)
    .setRequired(true)
    .setPlaceholder('What worked, what didn’t, who should watch it…');
  if (existing?.content) content.setValue(existing.content);
  const spoiler = new StringSelectMenuBuilder()
    .setCustomId('spoiler')
    .setRequired(true)
    .addOptions(
      { label: 'No spoilers', value: 'no', emoji: '✅', default: existing ? !existing.spoiler : !spoilerDefault },
      { label: 'Contains spoilers — hide the text behind a warning', value: 'yes', emoji: '⚠️', default: existing ? existing.spoiler : spoilerDefault }
    );
  return new ModalBuilder()
    .setCustomId(`rv:m:${mediaId}`)
    .setTitle(ui.clip(`${existing ? 'Edit review' : 'Review'} · ${mediaTitle || 'anime'}`, 45))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Reviewing **${ui.esc(mediaTitle || 'this anime')}**. Your review appears on your profile and in /review browse.`))
    .addLabelComponents(
      new LabelBuilder().setLabel('Score').setStringSelectMenuComponent(rating),
      new LabelBuilder().setLabel('Title').setTextInputComponent(title),
      new LabelBuilder().setLabel('Review').setTextInputComponent(content),
      new LabelBuilder().setLabel('Spoilers').setStringSelectMenuComponent(spoiler)
    );
}

function scoreLine(r) {
  return `${ui.stars10(r.rating)}  **${r.rating}/10** · ${SCORE_LABELS[r.rating] || ''}`;
}

function bodyText(r, max = 2600) {
  const body = ui.softEsc(ui.clip(r.content, max));
  return r.spoiler ? `> ⚠️ **Spoiler warning** — tap to reveal\n||${body.replace(/\|\|/g, '| |')}||` : body;
}

// Full review card. mode: 'public' (posted in a channel), 'author', 'reader'.
function reviewCard(r, author, { mode = 'reader', backId, notice } = {}) {
  const pal = paletteFor(author?.profile);
  const likes = r.likes?.length || 0;
  const children = [
    notice ? ui.text(notice) : null,
    ui.row([`-# REVIEW  ·  ${ui.esc(ui.clip(r.mediaTitle, 80)).toUpperCase()}`, `## ${ui.esc(r.title)}`, scoreLine(r)], r.cover),
    ui.divider(),
    ui.text(bodyText(r)),
    ui.gap(),
    ui.text(
      `-# by <@${r.authorId}> · ${ui.shortDate(r.createdAt)}${r.editedAt ? ` · edited ${ui.relTime(r.editedAt)}` : ''}${likes ? ` · ❤️ ${likes} found this helpful` : ''}`
    ),
  ];
  const buttons = [ui.button(`rv:like:${r.id}:${mode === 'public' ? 'p' : 'e'}`, likes ? `Helpful · ${likes}` : 'Helpful', { emoji: '❤️', style: ui.ButtonStyle.Danger })];
  buttons.push(ui.button(`rv:b:recent:0:${r.mediaId}`, 'More on this anime', { emoji: '📖' }));
  if (r.siteUrl) buttons.push(ui.linkButton(r.siteUrl, 'AniList', '🔗'));
  children.push(ui.actionRow(buttons));
  if (mode === 'author') {
    children.push(
      ui.actionRow(
        ui.button(`rv:edit:${r.id}`, 'Edit', { emoji: '✏️' }),
        ui.button(`rv:feat:${r.id}`, author?.profile?.featuredReviewId === r.id ? 'Featured ✓' : 'Feature on profile', { emoji: '📌', disabled: author?.profile?.featuredReviewId === r.id }),
        ui.button(`rv:share:${r.id}`, 'Share here', { emoji: '📣', style: ui.ButtonStyle.Primary }),
        ui.button(`rv:del:${r.id}`, 'Delete', { emoji: '🗑️', style: ui.ButtonStyle.Danger })
      )
    );
  }
  if (backId) children.push(ui.actionRow(ui.button(backId, 'Back to reviews', { emoji: '↩️' })));
  return ui.fit([ui.card(pal.accent, children)]);
}

/* -------------------------------- browsing -------------------------------- */

function filterReviews(s, sort, { viewerId, guildId, mediaId }) {
  let list = Object.values(s.reviews);
  if (mediaId) list = list.filter((r) => r.mediaId === mediaId);
  if (sort === 'mine') list = list.filter((r) => r.authorId === viewerId);
  if (sort === 'server') list = list.filter((r) => r.guildId === guildId || s.users[r.authorId]?.guilds?.includes(guildId));
  // respect authors who hide their reviews
  list = list.filter((r) => r.authorId === viewerId || social.canView(social.peekUser(s, r.authorId), viewerId, r.authorId, 'reviews'));
  const byDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  if (sort === 'liked') list.sort((a, b) => (b.likes?.length || 0) - (a.likes?.length || 0) || byDate(a, b));
  else if (sort === 'rating') list.sort((a, b) => b.rating - a.rating || (b.likes?.length || 0) - (a.likes?.length || 0));
  else list.sort(byDate);
  return list;
}

// Compact review rows (also used by the profile's Reviews tab).
function reviewRows(list) {
  return list.map((r) =>
    ui.row(
      [
        `**${ui.esc(ui.clip(r.title, 70))}**  ·  ${ui.stars10(r.rating)} ${r.rating}/10`,
        `-# ${ui.esc(ui.clip(r.mediaTitle, 50))} · by <@${r.authorId}> · ${ui.relTime(r.createdAt)}${r.likes?.length ? ` · ❤️ ${r.likes.length}` : ''}`,
        r.spoiler ? '-# ⚠️ Contains spoilers' : ui.softEsc(ui.clip(r.content.replace(/\s+/g, ' '), 150)),
      ],
      r.cover
    )
  );
}

function browsePayload(s, { sort = 'recent', page = 0, viewerId, guildId, mediaId = null }) {
  const list = filterReviews(s, sort, { viewerId, guildId, mediaId });
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const mid = mediaId ? `:${mediaId}` : '';

  let heading = `### ✍️ Reviews  ·  ${SORTS[sort]?.label || 'Newest'}`;
  let sub = `${list.length} review${list.length === 1 ? '' : 's'}`;
  if (mediaId && list.length) {
    const avg = list.reduce((a, r) => a + r.rating, 0) / list.length;
    heading = `### ✍️ ${ui.esc(ui.clip(list[0].mediaTitle, 70))}`;
    sub = `${list.length} review${list.length === 1 ? '' : 's'} · community score **${avg.toFixed(1)}/10** ${ui.stars10(Math.round(avg))}`;
  }
  const children = [ui.text(`${heading}\n-# ${sub}`)];
  children.push(
    ui.select(
      `rv:bs${mid}`,
      'Sort reviews…',
      Object.entries(SORTS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, description: v.description, default: k === sort }))
    )
  );
  children.push(ui.divider());
  if (!slice.length) {
    children.push(
      ui.text(
        sort === 'mine'
          ? '*You haven’t written any reviews yet.* Use `/review write` or the ✍️ **Review** button on any activity post.'
          : '*No reviews here yet — be the first!* Use `/review write` or tap ✍️ **Review** on an activity post.'
      )
    );
  } else {
    children.push(...reviewRows(slice));
    children.push(
      ui.select(
        `rv:pick:${sort}:${page}${mid}`,
        'Read a review…',
        slice.map((r) => ({ label: ui.clip(r.title, 100), value: r.id, description: ui.clip(`${r.rating}/10 · ${r.mediaTitle}`, 100) }))
      )
    );
  }
  if (pages > 1) {
    children.push(
      ui.actionRow(
        ui.button(`rv:b:${sort}:${Math.max(0, page - 1)}${mid}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
        ui.button(`rv:noop`, `${page + 1} / ${pages}`, { disabled: true }),
        ui.button(`rv:b:${sort}:${Math.min(pages - 1, page + 1)}${mid}`, 'Next', { emoji: '▶️', disabled: page >= pages - 1 })
      )
    );
  }
  return ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
}

/* -------------------------------- actions -------------------------------- */

async function openWriteForm(interaction, mediaId, knownTitle) {
  const s = await ctx.loadSocial();
  const u = social.peekUser(s, interaction.user.id);
  const existing = social.reviewFor(s, interaction.user.id, mediaId);
  const title = knownTitle || existing?.mediaTitle || titleCache.get(mediaId) || null;
  return interaction.showModal(reviewModal(mediaId, title, existing, u.prefs.spoilerDefault));
}

async function reply(interaction, payload, { ephemeral = true } = {}) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    const v2 = payload.components && !payload.content ? ui.V2 : 0;
    return await interaction.reply({ ...payload, flags: v2 | (ephemeral ? ui.EPHEMERAL : 0) });
  } catch (e) {
    console.error('Review reply failed:', e.message);
  }
}

async function update(interaction, payload) {
  try {
    if (interaction.message) return await interaction.update(payload);
    return await reply(interaction, payload);
  } catch (e) {
    console.error('Review update failed:', e.message);
  }
}

async function onModal(interaction) {
  const mediaId = parseInt(interaction.customId.split(':')[2], 10);
  const me = interaction.user.id;
  let rating = 0;
  let spoiler = false;
  try {
    rating = parseInt(interaction.fields.getStringSelectValues('rating')?.[0], 10);
    spoiler = interaction.fields.getStringSelectValues('spoiler')?.[0] === 'yes';
  } catch {
    /* validated below */
  }
  const title = (interaction.fields.getTextInputValue('title') || '').trim();
  const content = (interaction.fields.getTextInputValue('content') || '').trim();
  if (!(rating >= 1 && rating <= 10) || !title || content.length < 30) {
    return reply(interaction, { content: 'Please pick a score and write a title and at least a couple of sentences.' });
  }

  await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
  const media = await getMediaLite(mediaId).catch(() => null);
  const s = await ctx.loadSocial();
  const u = social.getUser(s, me);
  social.markGuild(u, interaction.guildId);
  let r = social.reviewFor(s, me, mediaId);
  const now = new Date().toISOString();
  const snap = media ? snapshot(media) : null;
  if (r) {
    Object.assign(r, { rating, title, content, spoiler, editedAt: now });
    if (snap) Object.assign(r, { mediaTitle: snap.title, cover: snap.cover, siteUrl: snap.siteUrl });
  } else {
    r = {
      id: social.newId('rv_'),
      authorId: me,
      mediaId,
      mediaTitle: snap?.title || titleCache.get(mediaId) || 'Unknown anime',
      cover: snap?.cover || null,
      siteUrl: snap?.siteUrl || `https://anilist.co/anime/${mediaId}`,
      rating,
      title,
      content,
      spoiler,
      likes: [],
      guildId: interaction.guildId || null,
      createdAt: now,
      editedAt: null,
    };
    s.reviews[r.id] = r;
    if (!u.profile.sections.includes('review')) u.profile.sections.push('review');
  }
  await ctx.saveSocial();
  return reply(interaction, reviewCard(r, u, { mode: 'author', notice: `✅ **Review ${r.editedAt ? 'updated' : 'published'}!** It’s on your profile now — tap **Share here** to post it in this channel.` }));
}

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const me = interaction.user.id;
  const s = await ctx.loadSocial();

  if (action === 'noop') return interaction.deferUpdate().catch(() => {});
  if (action === 'write') return openWriteForm(interaction, parseInt(parts[2], 10));

  if (action === 'b' || action === 'bs') {
    const sort = action === 'bs' ? interaction.values[0] : parts[2];
    const page = action === 'bs' ? 0 : parseInt(parts[3], 10) || 0;
    const mediaId = parseInt(action === 'bs' ? parts[2] : parts[4], 10) || null;
    const payload = browsePayload(s, { sort, page, viewerId: me, guildId: interaction.guildId, mediaId });
    // From a public review card, open the list privately instead of replacing the card.
    if (interaction.message && !interaction.message.flags?.has?.(ui.EPHEMERAL)) return reply(interaction, payload);
    return update(interaction, payload);
  }

  const r = s.reviews[parts[2]];
  if (action === 'pick') {
    const picked = s.reviews[interaction.values[0]];
    if (!picked) return update(interaction, browsePayload(s, { viewerId: me, guildId: interaction.guildId }));
    const back = `rv:b:${parts[2]}:${parts[3]}${parts[4] ? `:${parts[4]}` : ''}`;
    return update(interaction, reviewCard(picked, social.peekUser(s, picked.authorId), { mode: picked.authorId === me ? 'author' : 'reader', backId: back }));
  }
  if (!r) return reply(interaction, { content: 'That review was deleted.' });

  if (action === 'open') return update(interaction, reviewCard(r, social.peekUser(s, r.authorId), { mode: r.authorId === me ? 'author' : 'reader' }));

  if (action === 'like') {
    if (r.authorId === me) return reply(interaction, { content: 'You can’t mark your own review as helpful 😄' });
    r.likes = r.likes || [];
    const had = r.likes.includes(me);
    r.likes = had ? r.likes.filter((x) => x !== me) : [...r.likes, me];
    social.markGuild(social.getUser(s, me), interaction.guildId);
    await ctx.saveSocial();
    const mode = parts[3] === 'p' ? 'public' : r.authorId === me ? 'author' : 'reader';
    // On a public card, refresh the count for everyone; elsewhere refresh the private view.
    return update(interaction, reviewCard(r, social.peekUser(s, r.authorId), { mode }));
  }

  if (r.authorId !== me) return reply(interaction, { content: 'Only the author can do that.' });
  const author = social.getUser(s, me);

  if (action === 'edit') return interaction.showModal(reviewModal(r.mediaId, r.mediaTitle, r));
  if (action === 'feat') {
    author.profile.featuredReviewId = r.id;
    if (!author.profile.sections.includes('review')) author.profile.sections.push('review');
    await ctx.saveSocial();
    return update(interaction, reviewCard(r, author, { mode: 'author' }));
  }
  if (action === 'share') {
    try {
      await interaction.channel.send(reviewCard(r, author, { mode: 'public' }));
      return reply(interaction, { content: '📣 Shared in this channel.' });
    } catch (e) {
      return reply(interaction, { content: `Couldn’t post here: ${e.message}` });
    }
  }
  if (action === 'del') {
    return update(
      interaction,
      ui.fit([
        ui.card(ui.ANILIST_BLUE, [
          ui.text(`### 🗑️ Delete your review of ${ui.esc(r.mediaTitle)}?\nThis removes it from your profile and from browsing. It can’t be undone.`),
          ui.actionRow(ui.button(`rv:delok:${r.id}`, 'Delete review', { style: ui.ButtonStyle.Danger, emoji: '🗑️' }), ui.button(`rv:open:${r.id}`, 'Keep it', { emoji: '↩️' })),
        ]),
      ])
    );
  }
  if (action === 'delok') {
    delete s.reviews[r.id];
    if (author.profile.featuredReviewId === r.id) author.profile.featuredReviewId = null;
    await ctx.saveSocial();
    return update(interaction, ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text('🗑️ Review deleted.')])]));
  }
}

module.exports = {
  SCORE_LABELS,
  SORTS,
  reviewCard,
  reviewRows,
  browsePayload,
  filterReviews,
  openWriteForm,
  onModal,
  onComponent,
  rememberTitle,
  scoreLine,
  bodyText,
};
