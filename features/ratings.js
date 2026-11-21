const { ModalBuilder, LabelBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { ctx } = require('./ctx');
const { getMediaLite, snapshot, titleOf } = require('./anilistSocial');

/* ---------------------------------------------------------------------------
 * Ratings — a quick 1-10 score anyone can give an anime (no review needed).
 *
 *  • ⭐ Rate on every activity post, or /rate anime score [note]
 *  • /ratings                 the server's anime ranked by members' scores
 *  • /ratings user:@someone   one person's ratings page (sortable, paged)
 *  • /ratings anime:<title>   everyone here's score for one anime + spread
 *
 * A written review's score counts as that person's rating too (a quick
 * rating wins if they gave both). Stored in social.ratings[userId][mediaId]
 * = { s: score, n: note, at, t: title, c: cover, u: url }.
 *
 * ids: rt:m:<mediaId> (form) · rt:edit:<mediaId> · rt:rm:<mediaId> ·
 *      rt:a:<mediaId> · rt:u:<userId>:<page>:<sort> · rt:b:<page> · rt:open
 * ------------------------------------------------------------------------- */

const ACCENT = 0xfbbf24;
const PAGE = 8;
const LABELS = { 10: 'Masterpiece', 9: 'Amazing', 8: 'Great', 7: 'Good', 6: 'Fine', 5: 'Average', 4: 'Meh', 3: 'Bad', 2: 'Awful', 1: 'Appalling' };
const titles = new Map(); // mediaId -> title (so forms can open instantly)

function rememberTitle(id, title) {
  if (!id || !title) return;
  titles.set(Number(id), title);
  if (titles.size > 2000) titles.delete(titles.keys().next().value);
}

// Every rating a person has: quick ratings + review scores.
function ratingsOf(s, userId) {
  const out = new Map();
  for (const r of Object.values(s.reviews || {})) {
    if (r.authorId === userId && r.rating) out.set(Number(r.mediaId), { s: r.rating, at: r.editedAt || r.createdAt, t: r.mediaTitle, c: r.cover, u: r.siteUrl || `https://anilist.co/anime/${r.mediaId}`, review: r.id });
  }
  for (const [id, r] of Object.entries(s.ratings?.[userId] || {})) out.set(Number(id), { ...r, review: out.get(Number(id))?.review || null });
  return out;
}

function ratingOf(s, userId, mediaId) {
  return ratingsOf(s, userId).get(Number(mediaId)) || null;
}

// Discord ids of people who use AniTracker in this server.
function memberIds(core, s, guildId) {
  const ids = new Set();
  for (const [uid, u] of Object.entries(s.users || {})) if ((u.guilds || []).includes(guildId)) ids.add(uid);
  for (const t of core.guilds?.[guildId]?.users || []) {
    const owner = social.discordFor(core, t.id);
    if (owner) ids.add(owner);
  }
  return ids;
}

function scoresFor(core, s, guildId, mediaId) {
  const out = [];
  for (const uid of memberIds(core, s, guildId)) {
    const r = ratingOf(s, uid, mediaId);
    if (r) out.push({ userId: uid, ...r });
  }
  return out.sort((a, b) => b.s - a.s);
}

const avg = (list) => (list.length ? list.reduce((a, r) => a + r.s, 0) / list.length : null);

// Every anime rated in this server: { mediaId, avg, count, t, c, u }
function serverBoard(core, s, guildId) {
  const byMedia = new Map();
  for (const uid of memberIds(core, s, guildId)) {
    for (const [mediaId, r] of ratingsOf(s, uid)) {
      const x = byMedia.get(mediaId) || { mediaId, scores: [], t: r.t, c: r.c, u: r.u };
      x.scores.push(r.s);
      x.t ||= r.t;
      x.c ||= r.c;
      byMedia.set(mediaId, x);
    }
  }
  return [...byMedia.values()]
    .map((x) => ({ ...x, count: x.scores.length, avg: x.scores.reduce((a, b) => a + b, 0) / x.scores.length }))
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
}

function histogram(list) {
  const counts = Array.from({ length: 10 }, (_, i) => list.filter((r) => Math.round(r.s) === 10 - i).length);
  const max = Math.max(...counts, 1);
  return counts
    .map((c, i) => (c ? `\`${String(10 - i).padStart(2, ' ')}\` ${'█'.repeat(Math.max(1, Math.round((c / max) * 12)))} ${c}` : null))
    .filter(Boolean)
    .join('\n');
}

/* ---------------------------------- form ---------------------------------- */

function rateModal(mediaId, title, existing) {
  const score = new StringSelectMenuBuilder()
    .setCustomId('score')
    .setPlaceholder('Pick a score')
    .setRequired(true)
    .addOptions(
      Object.entries(LABELS)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([v, l]) => ({ label: `${v}/10 — ${l}`, value: v, description: ui.stars10(Number(v)), default: existing?.s === Number(v) }))
    );
  const note = new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('e.g. “peak fiction, ep 7 broke me” (no spoilers!)');
  if (existing?.n) note.setValue(existing.n);
  return new ModalBuilder()
    .setCustomId(`rt:m:${mediaId}`)
    .setTitle(ui.clip(`Rate · ${title || 'this anime'}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Your score').setStringSelectMenuComponent(score),
      new LabelBuilder().setLabel('One-line take').setDescription('Optional — shows next to your score').setTextInputComponent(note)
    );
}

async function openRateForm(interaction, mediaId, knownTitle) {
  const s = await ctx.loadSocial();
  const existing = s.ratings?.[interaction.user.id]?.[mediaId] || null;
  const title = knownTitle || existing?.t || titles.get(Number(mediaId)) || null;
  return interaction.showModal(rateModal(mediaId, title, existing)).catch((e) => console.error('Rate form failed:', e.message));
}

async function saveRating(userId, guildId, media, score, note) {
  const s = await ctx.loadSocial();
  s.ratings ||= {};
  const mine = (s.ratings[userId] ||= {});
  const snap = snapshot(media);
  mine[media.id] = { s: score, n: note || null, at: new Date().toISOString(), t: snap.title, c: snap.cover, u: snap.siteUrl };
  const u = social.getUser(s, userId);
  social.markGuild(u, guildId);
  await ctx.saveSocial();
  rememberTitle(media.id, snap.title);
  return mine[media.id];
}

function savedCard(media, r, guildId, core, s, userId) {
  const snap = snapshot(media);
  const here = scoresFor(core, s, guildId, media.id);
  const a = avg(here);
  const head = media.bannerImage ? ui.gallery([{ url: media.bannerImage, description: snap.title }]) : null;
  return ui.fit([
    ui.card(ACCENT, [
      head,
      ui.text(
        [
          '-# ⭐ RATED',
          `### ${ui.esc(snap.title)}`,
          `\`${ui.bar(r.s, 10, 10)}\`  **${r.s}/10** · ${LABELS[r.s]}${r.n ? `\n> ${ui.softEsc(r.n)}` : ''}\n-# ${here.length > 1 ? `Server average **${a.toFixed(1)}** from ${here.length} people` : 'You’re the first here to rate it'}`,
        ].join('\n')
      ),
      ui.actionRow(
        ui.button(`rt:a:${media.id}`, 'Everyone’s ratings', { emoji: '👥', style: ui.ButtonStyle.Primary }),
        ui.button(`rt:u:${userId}:0:high`, 'My ratings', { emoji: '⭐' }),
        ui.button(`rt:edit:${media.id}`, 'Change', { emoji: '✏️' })
      ),
    ]),
  ]);
}

async function onModal(interaction) {
  const mediaId = parseInt(interaction.customId.split(':')[2], 10);
  let score = 0;
  try {
    score = parseInt(interaction.fields.getStringSelectValues('score')?.[0], 10);
  } catch {
    score = 0;
  }
  const note = (interaction.fields.getTextInputValue('note') || '').trim().replace(/\s+/g, ' ') || null;
  if (!(score >= 1 && score <= 10)) return interaction.reply({ content: 'Pick a score from 1 to 10.', flags: ui.EPHEMERAL }).catch(() => {});
  await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
  const media = await getMediaLite(mediaId).catch(() => null);
  if (!media) return ctx.respond(interaction, { content: '⚠️ AniList isn’t responding right now (their side) — your rating wasn’t saved. Try again in a bit.' });
  const r = await saveRating(interaction.user.id, interaction.guildId, media, score, note);
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  return ctx.respond(interaction, savedCard(media, r, interaction.guildId, core, s, interaction.user.id));
}

/* --------------------------------- views --------------------------------- */

async function animePayload(guildId, mediaId, viewerId) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const media = await getMediaLite(mediaId).catch(() => null);
  const list = scoresFor(core, s, guildId, mediaId);
  const title = media ? titleOf(media) : list[0]?.t || `AniList #${mediaId}`;
  const url = media?.siteUrl || `https://anilist.co/anime/${mediaId}`;
  const a = avg(list);
  const children = [
    media?.bannerImage ? ui.gallery([{ url: media.bannerImage, description: title }]) : null,
    ui.text(
      [
        '-# ⭐ RATINGS IN THIS SERVER',
        `## [${ui.esc(ui.clip(title, 80))}](${url})`,
        list.length
          ? `\`${ui.bar(a, 10, 10)}\`  **${a.toFixed(1)}/10** from ${list.length} ${list.length === 1 ? 'person' : 'people'}${typeof media?.averageScore === 'number' ? ` · AniList ${(media.averageScore / 10).toFixed(1)}` : ''}`
          : `-# Nobody here has rated it yet${typeof media?.averageScore === 'number' ? ` · AniList ${(media.averageScore / 10).toFixed(1)}` : ''}`,
      ].join('\n')
    ),
  ].filter(Boolean);
  if (list.length) {
    children.push(ui.divider());
    children.push(
      ui.text(
        list
          .slice(0, 20)
          .map((r) => `\`${ui.bar(r.s, 10, 10)}\` **${r.s}**/10 · <@${r.userId}>${r.review ? ' · ✍️ review' : ''}${r.n ? `\n-# “${ui.softEsc(ui.clip(r.n, 110))}”` : ''}`)
          .join('\n')
      )
    );
    if (list.length > 1) children.push(ui.text(`${ui.label('Spread')}\n${histogram(list)}`));
  }
  const mine = viewerId ? ratingOf(s, viewerId, mediaId) : null;
  children.push(ui.divider());
  children.push(
    ui.actionRow(
      ui.button(`rt:edit:${mediaId}`, mine ? `Change my ${mine.s}/10` : 'Rate it', { emoji: '⭐', style: ui.ButtonStyle.Primary }),
      ui.button('rt:b:0', 'Server top rated', { emoji: '🏆' })
    )
  );
  return ui.fit([ui.card(ACCENT, children)]);
}

const SORTS = { high: 'Highest first', low: 'Lowest first', recent: 'Most recent' };

async function userPayload(ownerId, viewerId, page = 0, sort = 'high') {
  const s = await ctx.loadSocial();
  const u = social.peekUser(s, ownerId);
  if (!social.canView(u, viewerId, ownerId, 'reviews')) return ui.notice({ accent: ACCENT, title: '🔒 Private', body: `<@${ownerId}> keeps their ratings private.` });
  let list = [...ratingsOf(s, ownerId)].map(([mediaId, r]) => ({ mediaId, ...r }));
  if (sort === 'low') list.sort((a, b) => a.s - b.s);
  else if (sort === 'recent') list.sort((a, b) => new Date(b.at) - new Date(a.at));
  else list.sort((a, b) => b.s - a.s || new Date(b.at) - new Date(a.at));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const a = avg(list);
  const own = ownerId === viewerId;
  const children = [ui.text(`-# ⭐ RATINGS\n## ${own ? 'Your' : `<@${ownerId}>’s`} ratings\n-# ${list.length ? `${list.length} anime rated · average **${a.toFixed(1)}**/10` : 'Nothing rated yet'}`)];
  if (!list.length) {
    children.push(ui.text(own ? '*Tap ⭐ **Rate** on any activity post, or use `/rate`.*' : '*They haven’t rated anything yet.*'));
  } else {
    const slice = list.slice(page * PAGE, page * PAGE + PAGE);
    const artRoutes = require('./artRoutes');
    const top5 = slice.slice(0, 5);
    const bl = artRoutes.bannerListUrl(top5.map((r) => ({ mediaId: r.mediaId, detail: `${r.s}/10 · ${LABELS[r.s] || ''}${r.n ? ` · “${r.n}”` : ''}` })), null, { start: page * PAGE + 1 });
    const g = bl ? ui.gallery([{ url: bl, description: top5.map((r) => `${r.t} · ${r.s}/10`).join(' · ') }]) : null;
    if (g) {
      artRoutes.warm(bl);
      children.push(g);
    }
    children.push(
      ui.text(
        slice
          .map((r, i) => `\`${String(page * PAGE + i + 1).padStart(2, '0')}\` \`${ui.bar(r.s, 10, 8)}\` **${r.s}**/10 · [${ui.esc(ui.clip(r.t || `#${r.mediaId}`, 55))}](${r.u || `https://anilist.co/anime/${r.mediaId}`})${r.n ? `\n-# “${ui.softEsc(ui.clip(r.n, 100))}”` : ''}`)
          .join('\n')
      )
    );
    if (list.length > 2) children.push(ui.text(`${ui.label('How they score')}\n${histogram(list)}`));
  }
  children.push(ui.divider());
  children.push(ui.select(`rt:u:${ownerId}:0:sort`, 'Sort…', Object.entries(SORTS).map(([k, l]) => ({ label: l, value: k, default: k === sort }))));
  children.push(
    ui.actionRow(
      ui.button(`rt:u:${ownerId}:${page - 1}:${sort}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
      ui.button(`rt:u:${ownerId}:${page + 1}:${sort}`, `Page ${page + 1}/${pages}`, { emoji: '▶️', disabled: page >= pages - 1 }),
      ui.button('rt:b:0', 'Server top rated', { emoji: '🏆' })
    )
  );
  return ui.fit([ui.card(ACCENT, children)]);
}

async function boardPayload(guildId, page = 0) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const board = serverBoard(core, s, guildId);
  const pages = Math.max(1, Math.ceil(board.length / 10));
  page = Math.min(Math.max(0, page), pages - 1);
  const children = [ui.text(`-# ⭐ RATINGS · ${ui.esc(ctx.client?.guilds.cache.get(guildId)?.name || 'THIS SERVER').toUpperCase()}\n## 🏆 Top rated by this server\n-# ${board.length} anime rated by members · ⭐ Rate on any post or \`/rate\``)];
  const medals = ['🥇', '🥈', '🥉'];
  if (!board.length) children.push(ui.text('*Nobody here has rated anything yet — be the first!*'));
  else {
    const slice = board.slice(page * 10, page * 10 + 10);
    if (page === 0) {
      const artRoutes = require('./artRoutes');
      const top = slice.slice(0, 3);
      const bl = artRoutes.bannerListUrl(top.map((x) => ({ mediaId: x.mediaId, detail: `${x.avg.toFixed(1)}/10 · ${x.count} rating${x.count === 1 ? '' : 's'}` })));
      const g = bl ? ui.gallery([{ url: bl, description: top.map((x) => `${x.t} · ${x.avg.toFixed(1)}`).join(' · ') }]) : null;
      if (g) {
        artRoutes.warm(bl);
        children.push(g);
      }
    }
    children.push(
      ui.text(
        slice
          .map((x, i) => {
            const n = page * 10 + i;
            return `${medals[n] || `\`#${n + 1}\``} **[${ui.esc(ui.clip(x.t || `#${x.mediaId}`, 55))}](${x.u || `https://anilist.co/anime/${x.mediaId}`})**\n\`${ui.bar(x.avg, 10, 12)}\` **${x.avg.toFixed(1)}** · ${x.count} rating${x.count === 1 ? '' : 's'}`;
          })
          .join('\n')
      )
    );
    children.push(ui.select('rt:open', 'See who rated what…', slice.map((x) => ({ label: ui.clip(x.t || `#${x.mediaId}`, 100), value: String(x.mediaId), description: `${x.avg.toFixed(1)}/10 · ${x.count} rating${x.count === 1 ? '' : 's'}` }))));
  }
  children.push(
    ui.actionRow(
      ui.button(`rt:b:${page - 1}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
      ui.button(`rt:b:${page + 1}`, `Page ${page + 1}/${pages}`, { emoji: '▶️', disabled: page >= pages - 1 })
    )
  );
  // Raters: who rates the most here
  const raters = [...memberIds(core, s, guildId)]
    .map((uid) => ({ uid, n: ratingsOf(s, uid).size, a: avg([...ratingsOf(s, uid).values()]) }))
    .filter((x) => x.n)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  if (raters.length) children.push(ui.text(`${ui.label('Most ratings')}\n${raters.map((x, i) => `${medals[i] || `\`#${i + 1}\``} <@${x.uid}> · **${x.n}** rated · avg ${x.a.toFixed(1)}`).join('\n')}`));
  if (raters.length) children.push(ui.select('rt:who', 'Open someone’s ratings page…', raters.map((x) => ({ label: ctx.client?.users.cache.get(x.uid)?.username || `User ${x.uid.slice(-4)}`, value: x.uid, description: `${x.n} rated · avg ${x.a.toFixed(1)}` }))));
  return ui.fit([ui.card(ACCENT, children)]);
}

// Community score shown on activity posts ("💬 8.3 here (4)").
async function postExtras({ activity, guildId }) {
  if (!guildId || !activity?.media) return {};
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  rememberTitle(activity.media.id, titleOf(activity.media));
  const list = scoresFor(core, s, guildId, activity.media.id);
  if (!list.length) return {};
  return { ratingLine: `👥 ${avg(list).toFixed(1)} here (${list.length})` };
}

/* -------------------------------- handlers -------------------------------- */

async function handleRate(interaction, media, score, note) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
  if (!media) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList.' });
  const r = await saveRating(interaction.user.id, interaction.guildId, media, score, note);
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  return ctx.respond(interaction, savedCard(media, r, interaction.guildId, core, s, interaction.user.id));
}

async function handleRatings(interaction, { user, mediaId }) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply().catch(() => {});
  if (mediaId === -1) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList — pick it from the suggestions while you type.' });
  if (mediaId) return ctx.respond(interaction, await animePayload(interaction.guildId, mediaId, interaction.user.id));
  if (user) return ctx.respond(interaction, await userPayload(user.id, interaction.user.id, 0, 'high'));
  return ctx.respond(interaction, await boardPayload(interaction.guildId, 0));
}

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const kind = parts[1];
  const me = interaction.user.id;
  if (kind === 'edit') return openRateForm(interaction, parseInt(parts[2], 10));
  // Someone else's public card → private copy; otherwise change it in place.
  const show = async (build) => {
    const isPrivate = Boolean(interaction.message?.flags?.has?.(ui.EPHEMERAL));
    const invoker = interaction.message?.interactionMetadata?.user?.id;
    try {
      if (isPrivate || invoker === me) {
        await interaction.deferUpdate();
        return await interaction.editReply(await build());
      }
      await interaction.deferReply({ flags: ui.EPHEMERAL });
      return await interaction.editReply(await build());
    } catch (e) {
      console.error('Ratings view failed:', e.message);
    }
  };
  if (kind === 'a') return show(() => animePayload(interaction.guildId, parseInt(parts[2], 10), me));
  if (kind === 'open') return show(() => animePayload(interaction.guildId, parseInt(interaction.values[0], 10), me));
  if (kind === 'who') return show(() => userPayload(interaction.values[0], me, 0, 'high'));
  if (kind === 'b') return show(() => boardPayload(interaction.guildId, parseInt(parts[2], 10) || 0));
  if (kind === 'u') {
    const owner = parts[2];
    const sort = parts[4] === 'sort' ? interaction.values[0] : parts[4];
    return show(() => userPayload(owner, me, parseInt(parts[3], 10) || 0, SORTS[sort] ? sort : 'high'));
  }
  if (kind === 'rm') {
    const s = await ctx.loadSocial();
    if (s.ratings?.[me]) delete s.ratings[me][parts[2]];
    await ctx.saveSocial();
    return show(() => animePayload(interaction.guildId, parseInt(parts[2], 10), me));
  }
}

module.exports = { openRateForm, onModal, onComponent, handleRate, handleRatings, postExtras, ratingsOf, ratingOf, scoresFor, serverBoard, memberIds, rememberTitle, LABELS };
