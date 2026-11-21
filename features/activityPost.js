const { ButtonBuilder, ButtonStyle, ThumbnailBuilder, SectionBuilder, MessageFlags } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { pickTags } = require('./tags');
const { barUrl, paletteFor, publicUrl } = require('./themes');

/* ---------------------------------------------------------------------------
 * Activity posts, in Discord's modern layout (Components V2).
 *
 *  ┌─────────────────────────────────────────────┐
 *  │ [ anime banner ]                             │  full style
 *  │ ✦ Sep 🔥 5 · “currently losing to backlog”   │
 *  │ Watched episode 7 · Season 2 ▶️       [cover]│
 *  │ # Title                                      │
 *  │ EPISODE 7 OF 12 · 58%                        │
 *  │ [▰▰▰▰▰▰▱▱▱▱ progress bar]                    │
 *  │ ⭐ 8.4 · 🏷️ Isekai · Satire · ❤️ #12          │
 *  │ short synopsis…                              │
 *  │ ───────────────────────────────────────────  │
 *  │ [🤍 Like] [✍️ Review] [🗂️ Save] [📊 Info]    │
 *  │ 2m ago · tracked by @someone                 │
 *  └─────────────────────────────────────────────┘
 *
 * The owner's /settings still decide the style (full/compact/minimal), the
 * colour, and which details show. New in this layout: their profile status
 * (tagline) and a progress bar for the season they're watching.
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

function thumb(url, spoiler) {
  const t = new ThumbnailBuilder().setURL(ui.hd(url));
  if (spoiler) t.setSpoiler(true);
  return t;
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
 * @param o.username     AniList name
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
 */
function buildActivityPost(o) {
  const { username, activity, streak = 0, seasonInfo, look, ownerId, mentionId, cfg = {} } = o;
  const a = look?.activity || { style: 'full', color: 'cover', show: social.DEFAULT_ACTIVITY_FIELDS };
  const show = showSet(a);
  const style = a.style || 'full';
  const profileUrl = `https://anilist.co/user/${encodeURIComponent(username)}`;
  const when = activity.createdAt ? `<t:${Math.floor(activity.createdAt)}:R>` : '';

  const badges = ownerId ? social.badgesFor(ownerId).map((b) => ` \`${b.label}\``).join('') : '';
  const tagline = show.has('status') && look?.profile?.tagline ? `  ·  *${ui.softEsc(ui.clip(look.profile.tagline, 80))}*` : '';
  const streakBit = show.has('streak') && streak > 0 ? `  🔥 ${streak}` : '';
  const author = `-# ✦ **[${ui.esc(username)}](${profileUrl})**${badges}${streakBit}${tagline}`;
  const footerBits = [when, mentionId ? `tracked by <@${mentionId}>` : null, 'AniList'].filter(Boolean);
  const footer = ui.text(`-# ${footerBits.join('  ·  ')}`);

  let accent = typeof o.color === 'number' ? o.color : ui.ANILIST_BLUE;
  if (a.color === 'theme') accent = paletteFor(look?.profile).accent;
  else if (a.color === 'anilist') accent = ui.ANILIST_BLUE;

  const children = [];

  if (activity.__typename === 'ListActivity' && activity.media) {
    const m = activity.media;
    const si = seasonInfo || { rootId: m.id, rootTitle: m.title?.english || m.title?.romaji, rootSiteUrl: m.siteUrl };
    const mature = Boolean(m.isAdult);
    const blur = mature && cfg.mature !== 'show';
    const words = progressWords(activity);
    const seasonBit = si.season && m.type !== 'MANGA' ? `Season ${si.season}` : null;
    const caption = `**${statusVerb(activity.status)}${words ? ` ${words}` : ''}**${seasonBit ? `  ·  ${seasonBit}` : ''}  ${statusEmoji(activity.status)}`;
    const heading = style === 'minimal' ? '###' : style === 'compact' ? '##' : '#';
    const title = `${heading} [${ui.esc(ui.clip(si.rootTitle || 'Unknown title', 90))}](${si.rootSiteUrl || m.siteUrl})`;

    const cover = m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null;
    const showCover = show.has('cover') && ui.isHttpUrl(cover) && style !== 'minimal';

    // Banner across the top (full style). AniList's banner when there is one,
    // otherwise the bot paints one from the cover.
    if (style === 'full' && show.has('cover')) {
      const base = publicUrl();
      const hex6 = (n) => (n >>> 0).toString(16).padStart(6, '0').slice(-6);
      const banner = m.bannerImage || (base ? `${base}/banner/v1/anime/${m.id}/0b1622-${hex6(accent)}.jpg` : null);
      const g = banner ? ui.gallery([{ url: banner, description: si.rootTitle, spoiler: blur }]) : null;
      if (g) children.push(g);
    }

    const headLines = [author, caption, title];
    if (showCover) {
      children.push(new SectionBuilder().addTextDisplayComponents(...headLines.map((l) => ui.text(l))).setThumbnailAccessory(thumb(cover, blur)));
    } else {
      children.push(ui.text(headLines.join('\n')));
    }

    // Progress through this season.
    const prog = show.has('progress') && style !== 'minimal' ? seasonProgress(activity) : null;
    if (prog) {
      const unitLabel = prog.unit.toUpperCase();
      if (prog.total) {
        const line = `-# ${unitLabel} ${prog.done} OF ${prog.total}  ·  ${prog.pct}%${prog.next ? `  ·  ep ${prog.next.episode} airs <t:${prog.next.airingAt}:R>` : ''}`;
        children.push(ui.text(line));
        const bar = barUrl(prog.done, prog.total, accent);
        const g = bar ? ui.gallery([{ url: bar, description: `${prog.done} of ${prog.total}` }]) : null;
        if (g) children.push(g);
        else children.push(ui.text(`\`${ui.bar(prog.done, prog.total, 18)}\``));
      } else if (prog.done) {
        children.push(ui.text(`-# ${unitLabel} ${prog.done}  ·  still airing${prog.next ? `  ·  ep ${prog.next.episode} airs <t:${prog.next.airingAt}:R>` : ''}`));
      }
    }

    if (style !== 'minimal') {
      const info = [];
      if (show.has('rating') && typeof m.averageScore === 'number') info.push(`⭐ ${(m.averageScore / 10).toFixed(1)}`);
      if (o.ratingLine) info.push(o.ratingLine);
      const tags = show.has('genres') ? pickTags(m.tags, m.genres, 3) : [];
      if (tags.length) info.push(`🏷️ ${tags.map((t) => ui.esc(t)).join(' · ')}`);
      if (mature) info.push('🔞 Mature');
      if (show.has('popularity') && si.popularityRank) info.push(`❤️ #${si.popularityRank} Most Popular`);
      if (info.length) children.push(ui.text(info.join('  ·  ')));
      if (style === 'full' && show.has('description')) {
        const syn = ui.clip(stripDescription(m.description), 170);
        if (syn) children.push(ui.text(`-# ${ui.softEsc(syn)}`));
      }
    }

    children.push(ui.divider());
    const row = postButtons(si.rootId, m.id, { likeCount: o.likeCount || 0, rateLabel: o.rateLabel });
    if (o.preview) row.components.forEach((b) => b.setDisabled(true));
    children.push(row);
    children.push(footer);
  } else if (activity.__typename === 'TextActivity' || activity.__typename === 'MessageActivity') {
    const body = ui.clip(stripMarkup(activity.text || activity.message), 600) || '*(image or media post)*';
    children.push(ui.text(`${author}\n### 💬 ${activity.__typename === 'TextActivity' ? 'Posted a status' : 'Posted a message'}`));
    children.push(ui.text(ui.softEsc(body)));
    if (activity.siteUrl) children.push(ui.actionRow(ui.linkButton(activity.siteUrl, 'Open on AniList', '↗️')));
    children.push(footer);
  } else {
    children.push(ui.text(`${author}\n### 📺 New AniList activity`));
    children.push(ui.actionRow(ui.linkButton(profileUrl, 'Open profile', '↗️')));
    children.push(footer);
  }

  const payload = ui.fit([ui.card(accent, children)]);
  payload.allowedMentions = mentionId ? { users: [mentionId] } : { parse: [] };
  if (mentionId) payload.flags = ui.V2 | MessageFlags.SuppressNotifications; // quiet ping: no sound/push
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

module.exports = { buildActivityPost, postButtons, withLikeCount, findButtonId, seasonProgress, statusVerb, statusEmoji, NEW_FIELDS };
