const { ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { pickTags } = require('./tags');
const { paletteFor } = require('./themes');

/* ---------------------------------------------------------------------------
 * Activity posts: the classic embed look (author avatar, big cover), plus the
 * newer details: profile status, a progress bar for the season, specific
 * tags, the server's community score, and the ⭐ Rate button.
 * The owner's /settings still decide the style (full/compact/minimal), the
 * colour, and which details show.
 * ------------------------------------------------------------------------- */

const NEW_FIELDS = ['progress', 'status']; // added after people had saved settings

function statusEmoji(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complet')) return '✅';
  if (s.includes('drop')) return '🗑️';
  if (s.includes('paus')) return '⏸️';
  if (s.includes('plan')) return '📌';
  if (s.includes('rewatch') || s.includes('reread')) return '🔁';
  if (s.includes('watch')) return '▶️';
  if (s.includes('read')) return '📖';
  return '📺';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function statusVerb(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complet')) return 'Completed';
  if (s.includes('drop')) return 'Dropped';
  if (s.includes('paus')) return 'Paused';
  if (s.includes('plan')) return s.includes('read') ? 'Plans to read' : 'Plans to watch';
  if (s.includes('rewatch')) return 'Rewatched';
  if (s.includes('reread')) return 'Reread';
  if (s.includes('watch')) return 'Watched';
  if (s.includes('read')) return 'Read';
  return capitalize(s) || 'Updated';
}

// "episode 5" / "episodes 3 - 5" / "chapter 120"
function progressWords(activity) {
  if (!activity.progress) return '';
  const manga = activity.media?.type === 'MANGA';
  const range = String(activity.progress).includes('-');
  const unit = manga ? (range ? 'chapters' : 'chapter') : range ? 'episodes' : 'episode';
  return `${unit} ${activity.progress}`;
}

function lastNumber(progress) {
  const nums = String(progress || '')
    .split('-')
    .map((x) => parseInt(x.trim(), 10))
    .filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

// Where they are in THIS season: { done, total, pct, next }
function seasonProgress(activity) {
  const m = activity.media || {};
  const s = (activity.status || '').toLowerCase();
  const manga = m.type === 'MANGA';
  const total = manga ? m.chapters || null : m.episodes || null;
  let done = null;
  if (s.includes('complet')) done = total;
  else if (s.includes('watch') || s.includes('read') || s.includes('paus') || s.includes('drop')) done = lastNumber(activity.progress);
  if (done === null || done === undefined) return null;
  const shown = total ? Math.min(done, total) : done;
  return {
    done: shown,
    total,
    pct: total ? Math.round((shown / total) * 1000) / 10 : null,
    next: !manga && m.nextAiringEpisode?.airingAt ? m.nextAiringEpisode : null,
    unit: manga ? 'chapter' : 'episode',
  };
}

function showSet(a) {
  const show = new Set(a?.show || social.DEFAULT_ACTIVITY_FIELDS);
  // People who saved settings before a field existed get it switched on.
  if (!a?.v) for (const f of NEW_FIELDS) show.add(f);
  return show;
}

function likeButton(rootId, likeCount) {
  return new ButtonBuilder()
    .setCustomId(`like_${rootId}`)
    .setLabel(likeCount ? `Like · ${likeCount}` : 'Like')
    .setEmoji('🤍')
    .setStyle(ButtonStyle.Danger);
}

// The button row under every post. `extraButtons` lets later features add one.
function postButtons(rootId, infoMediaId, { likeCount = 0, rateLabel = false } = {}) {
  const target = infoMediaId || rootId;
  const buttons = [likeButton(rootId, likeCount)];
  if (rateLabel) {
    buttons.push(new ButtonBuilder().setCustomId(`rate_${target}`).setLabel(rateLabel === true ? 'Rate' : rateLabel).setEmoji('⭐').setStyle(ButtonStyle.Secondary));
  }
  buttons.push(
    new ButtonBuilder().setCustomId(`rvw_${target}`).setLabel('Review').setEmoji('✍️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`col_${rootId}`).setLabel('Save').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`info_${target}`).setLabel('More info').setEmoji('📊').setStyle(ButtonStyle.Secondary)
  );
  return ui.actionRow(buttons);
}

function stripDescription(text) {
  if (!text) return '';
  return text
    .replace(/~!.*?!~/gs, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkup(text) {
  return (text || '')
    .replace(/img\d*\(.*?\)/g, '')
    .replace(/webm\(.*?\)/g, '')
    .replace(/youtube\(.*?\)/g, '')
    .replace(/~!.*?!~/gs, '')
    .replace(/[_*~`]/g, '')
    .trim();
}

/**
 * Classic activity post (an embed), with the newer details folded in.
 *
 *  ┌──────────────────────────────────────────────┐
 *  │ (avatar) Sep 🔥 5 | @sep                      │  author line, links to AniList
 *  │ `💬 losing to my backlog`                     │  their profile status, as a bubble
 *  │ Watched episode 7 · Season 2 ▶️               │
 *  │ ▰▰▰▰▰▰▰▱▱▱▱▱  7 / 12 · 58% · ep 8 in 3 days  │  progress through this season
 *  │ # Title                                       │
 *  │ ⭐ 8.4 • 👥 8.3 here • ❤️ #12 • 🔞 • 🏷️ tags   │  tags last
 *  │ short synopsis…                               │
 *  │ [ big cover ]                                 │  full style (thumbnail otherwise)
 *  │ AniList · today at 4:12                       │
 *  └──────────────────────────────────────────────┘
 *  [🤍 Like] [⭐ Rate] [✍️ Review] [🗂️ Save] [📊 More info]
 *
 * @param o.username     AniList name
 * @param o.avatarUrl    AniList avatar (author icon)
 * @param o.activity     AniList activity (or a feed.js event shaped like one)
 * @param o.streak       current streak (days)
 * @param o.seasonInfo   { season, rootId, rootTitle, rootSiteUrl, popularityRank }
 * @param o.look         owner's social user (settings) or null
 * @param o.ownerId      Discord id of the profile owner (for badges)
 * @param o.mentionId    Discord id to quietly mention, or null
 * @param o.color        accent colour already worked out (cover colour)
 * @param o.cfg          server config (mature handling)
 * @param o.likeCount    current likes
 * @param o.ratingLine   optional extra info (community rating), string
 * @param o.preview      disable buttons (settings preview)
 * @param o.discordName  their Discord @handle (shown after the name)
 *
 * Returns the message payload plus `accent` and `spoilerUrl` (an 18+ cover
 * the caller attaches as a SPOILER_ file); strip both before sending.
 */
function buildActivityPost(o) {
  const { username, activity, streak = 0, seasonInfo, look, ownerId, mentionId, cfg = {} } = o;
  const a = look?.activity || { style: 'full', color: 'cover', show: social.DEFAULT_ACTIVITY_FIELDS };
  const show = showSet(a);
  const style = a.style || 'full';
  const profileUrl = `https://anilist.co/user/${encodeURIComponent(username)}`;

  let accent = typeof o.color === 'number' ? o.color : ui.ANILIST_BLUE;
  if (a.color === 'theme') accent = paletteFor(look?.profile).accent;
  else if (a.color === 'anilist') accent = ui.ANILIST_BLUE;

  const embed = new EmbedBuilder().setColor(accent);
  if (activity.createdAt) embed.setTimestamp(new Date(activity.createdAt * 1000));

  // Author line: avatar, name, streak | @their Discord. Their profile status
  // sits right under it as a bubble, like a Discord custom status.
  const streakBit = show.has('streak') && streak > 0 ? ` 🔥 ${streak}` : '';
  const handle = o.discordName ? ` | @${o.discordName}` : '';
  const author = { name: ui.clip(`${username}${streakBit}${handle}`, 250), url: profileUrl };
  if (ui.isHttpUrl(o.avatarUrl)) author.iconURL = o.avatarUrl;
  embed.setAuthor(author);
  const statusText = show.has('status') && look?.profile?.tagline ? ui.clip(String(look.profile.tagline).replace(/\s+/g, ' ').replace(/`/g, 'ˋ'), 90) : null;
  const bubble = statusText ? `\`💬 ${statusText}\`` : null;

  const badges = ownerId ? social.badgesFor(ownerId).map((b) => b.label) : [];
  const footerText = ['AniList', ...badges].join(' • ');
  let components = [];
  let spoilerUrl = null;

  if (activity.__typename === 'ListActivity' && activity.media) {
    const m = activity.media;
    const si = seasonInfo || { rootId: m.id, rootTitle: m.title?.english || m.title?.romaji, rootSiteUrl: m.siteUrl };
    const mature = Boolean(m.isAdult);
    // 18+ covers: 'blur' (default) sends the cover as a Discord spoiler
    // (click to reveal) — embeds can't spoiler their own image, so it rides
    // along as an attachment instead of sitting inside the card.
    const spoilerCover = mature && cfg.mature === 'blur';
    const hideCover = mature && cfg.mature === 'hide';
    const words = progressWords(activity);
    const seasonBit = si.season && m.type !== 'MANGA' ? ` · Season ${si.season}` : '';
    const caption = `${statusVerb(activity.status)}${words ? ` ${words}` : ''}${seasonBit} ${statusEmoji(activity.status)}`;
    const heading = style === 'minimal' ? '##' : '#';
    const top = [bubble, caption];
    // Progress through this season, as a bar, right under what they watched.
    const prog = show.has('progress') && style !== 'minimal' ? seasonProgress(activity) : null;
    if (prog) {
      const next = prog.next ? ` · ep ${prog.next.episode} <t:${prog.next.airingAt}:R>` : '';
      if (prog.total) top.push(`\`${ui.bar(prog.done, prog.total, 14)}\`  **${prog.done}** / ${prog.total} · ${Math.round(prog.pct)}%${next}`);
      else if (prog.done) top.push(`${prog.unit === 'chapter' ? 'Chapter' : 'Episode'} **${prog.done}** · still airing${next}`);
    }
    const parts = [`${top.filter(Boolean).join('\n')}\n${heading} [${ui.esc(ui.clip(si.rootTitle || 'Unknown title', 90))}](${si.rootSiteUrl || m.siteUrl})`];

    if (style !== 'minimal') {
      // rating · community score · popularity · mature · tags (tags last)
      const info = [];
      if (show.has('rating') && typeof m.averageScore === 'number') info.push(`⭐ ${(m.averageScore / 10).toFixed(1)}/10`);
      if (o.ratingLine) info.push(o.ratingLine);
      if (show.has('popularity') && si.popularityRank) info.push(`❤️ #${si.popularityRank} Most Popular`);
      if (mature) info.push(spoilerCover ? '🔞 Mature · cover in spoiler' : hideCover ? '🔞 Mature · cover hidden' : '🔞 Mature');
      const tags = show.has('genres') ? pickTags(m.tags, m.genres, 3) : [];
      if (tags.length) info.push(`🏷️ ${tags.map((t) => ui.esc(t)).join(', ')}`);
      if (info.length) parts.push(info.join('  •  '));
      if (show.has('description')) {
        const syn = ui.clip(stripDescription(m.description), style === 'compact' ? 100 : 160);
        if (syn) parts.push(ui.softEsc(syn));
      }
    }
    embed.setDescription(ui.clip(parts.join('\n\n'), 4000));

    const cover = m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null;
    if (show.has('cover') && !hideCover && !spoilerCover && ui.isHttpUrl(cover)) {
      if (style === 'full') embed.setImage(cover);
      else embed.setThumbnail(cover);
    }
    if (show.has('cover') && spoilerCover && ui.isHttpUrl(cover)) spoilerUrl = cover;
    embed.setFooter({ text: footerText });

    const row = postButtons(si.rootId, m.id, { likeCount: o.likeCount || 0, rateLabel: o.rateLabel });
    if (o.preview) row.components.forEach((b) => b.setDisabled(true));
    components = [row];
  } else if (activity.__typename === 'TextActivity' || activity.__typename === 'MessageActivity') {
    embed
      .setTitle(activity.__typename === 'TextActivity' ? '💬 Posted a status update' : '💬 Posted a message')
      .setDescription(ui.clip(`${bubble ? `${bubble}\n` : ''}${stripMarkup(activity.text || activity.message) || '*(image or media post)*'}`, 700))
      .setFooter({ text: footerText });
    if (ui.isHttpUrl(activity.siteUrl)) embed.setURL(activity.siteUrl);
    embed.setColor(ui.ANILIST_BLUE);
  } else {
    embed.setTitle('📺 New AniList activity').setURL(profileUrl).setFooter({ text: footerText }).setColor(ui.ANILIST_BLUE);
  }

  const payload = { embeds: [embed], components, allowedMentions: mentionId ? { users: [mentionId] } : { parse: [] }, accent, spoilerUrl };
  if (mentionId) {
    payload.content = `<@${mentionId}>`;
    payload.flags = MessageFlags.SuppressNotifications; // quiet ping: no sound/push
  }
  return payload;
}

// A short "caught up" post when someone had a pile of updates waiting
// (bot was down, AniList was slow…): one embed instead of a flood.
function buildCatchUpPost({ username, avatarUrl, items, mentionId, color }) {
  const profileUrl = `https://anilist.co/user/${encodeURIComponent(username)}`;
  const author = { name: username, url: profileUrl };
  if (ui.isHttpUrl(avatarUrl)) author.iconURL = avatarUrl;
  const lines = items.slice(0, 12).map((it) => `${statusEmoji(it.status)} **${ui.esc(ui.clip(it.title, 60))}** — ${it.text}`);
  if (items.length > 12) lines.push(`-# +${items.length - 12} more`);
  const embed = new EmbedBuilder()
    .setColor(typeof color === 'number' ? color : ui.ANILIST_BLUE)
    .setAuthor(author)
    .setTitle(`📦 Caught up on ${items.length} update${items.length === 1 ? '' : 's'}`)
    .setDescription(ui.clip(lines.join('\n'), 4000))
    .setFooter({ text: 'Bundled so the channel isn’t flooded • AniList' })
    .setTimestamp(new Date());
  const cover = items.find((it) => ui.isHttpUrl(it.cover))?.cover;
  if (cover) embed.setThumbnail(cover);
  const payload = { embeds: [embed], components: [], allowedMentions: mentionId ? { users: [mentionId] } : { parse: [] } };
  if (mentionId) {
    payload.content = `<@${mentionId}>`;
    payload.flags = MessageFlags.SuppressNotifications;
  }
  return payload;
}

// Rewrites the Like button label on an already-sent post (V2 or classic).
function withLikeCount(componentsJson, likeCount) {
  const walk = (c) => {
    if (!c || typeof c !== 'object') return c;
    const out = Array.isArray(c) ? c.map(walk) : { ...c };
    if (!Array.isArray(c)) {
      if (out.custom_id && out.custom_id.startsWith('like_')) out.label = likeCount ? `Like · ${likeCount}` : 'Like';
      if (out.components) out.components = walk(out.components);
      if (out.accessory) out.accessory = walk(out.accessory);
    }
    return out;
  };
  return walk(componentsJson);
}

// First "<prefix>_<id>" button id found on a message (any layout).
function findButtonId(componentsJson, prefix) {
  let found = null;
  const walk = (c) => {
    if (found || !c || typeof c !== 'object') return;
    if (Array.isArray(c)) return c.forEach(walk);
    if (typeof c.custom_id === 'string' && c.custom_id.startsWith(`${prefix}_`)) found = parseInt(c.custom_id.split('_')[1], 10) || null;
    walk(c.components);
    walk(c.accessory);
  };
  walk(componentsJson);
  return found;
}

module.exports = { buildActivityPost, buildCatchUpPost, progressWords, postButtons, withLikeCount, findButtonId, seasonProgress, statusVerb, statusEmoji, NEW_FIELDS };
