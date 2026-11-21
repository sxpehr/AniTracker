// Builds the private "More Info" panel for one anime/manga entry.
// Pure formatting — fetching happens in index.js.

const DEFAULT_COLOR = 0x3db4f2;

const FORMAT_LABELS = {
  TV: 'TV',
  TV_SHORT: 'TV Short',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
  MANGA: 'Manga',
  NOVEL: 'Light Novel',
  ONE_SHOT: 'One-shot',
};

const STATUS_LABELS = {
  FINISHED: 'Finished',
  RELEASING: 'Airing',
  NOT_YET_RELEASED: 'Not yet released',
  CANCELLED: 'Cancelled',
  HIATUS: 'On hiatus',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function titleOf(media) {
  return media.title?.english || media.title?.romaji || 'Unknown title';
}

function prettyEnum(value) {
  if (!value) return null;
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatDate(d) {
  if (!d || !d.year) return null;
  if (d.month) return `${MONTHS[d.month - 1]} ${d.day ? `${d.day}, ` : ''}${d.year}`;
  return String(d.year);
}

// Clean, spoiler-free synopsis that ends on a full sentence when it's cut.
function cleanDescription(text, max) {
  if (!text) return '';
  const cleaned = text
    .replace(/~!.*?!~/gs, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return `${stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.trimEnd()}…`;
}

function trailerUrl(trailer) {
  if (!trailer?.id) return null;
  if (trailer.site === 'youtube') return `https://www.youtube.com/watch?v=${trailer.id}`;
  if (trailer.site === 'dailymotion') return `https://www.dailymotion.com/video/${trailer.id}`;
  return null;
}

function hexToInt(hex) {
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return null;
  return parseInt(hex.replace('#', ''), 16);
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The private "More Info" panel, in Discord's modern layout (Components V2):
 * banner, cover beside the title, synopsis, the facts, tags, the main cast as
 * a portrait gallery, and link buttons.
 *
 * @param media  result of anilist.getMediaDetails
 * @param extra  { seasonNumber, totalSeasons, actions (ActionRowBuilder), footer, lead }
 */
function buildMoreInfo(media, extra = {}) {
  const ui = require('./features/ui');
  const { pickTags } = require('./features/tags');
  const isManga = media.type === 'MANGA';
  const title = titleOf(media);
  const color = hexToInt(media.coverImage?.color) || DEFAULT_COLOR;
  const children = [];

  if (extra.lead) children.push(ui.text(extra.lead));
  if (media.bannerImage) {
    const g = ui.gallery([{ url: media.bannerImage, description: `${title} banner`, spoiler: Boolean(media.isAdult) }]);
    if (g) children.push(g);
  }

  const kicker = [FORMAT_LABELS[media.format] || prettyEnum(media.format), STATUS_LABELS[media.status]];
  if (!isManga && extra.totalSeasons) {
    kicker.push(extra.seasonNumber && extra.totalSeasons > 1 ? `Season ${extra.seasonNumber} of ${extra.totalSeasons}` : `${extra.totalSeasons} season${extra.totalSeasons === 1 ? '' : 's'}`);
  }
  const altTitle = media.title?.native || (media.title?.english && media.title?.romaji !== media.title?.english ? media.title.romaji : null);
  const head = [`-# ${kicker.filter(Boolean).join('  ·  ').toUpperCase()}`, `## [${ui.esc(truncate(title, 120))}](${media.siteUrl})`, altTitle ? `-# *${ui.esc(truncate(altTitle, 150))}*` : null].filter(Boolean);
  children.push(ui.row(head, media.coverImage?.extraLarge || media.coverImage?.large));

  const synopsis = cleanDescription(media.description, 700);
  if (synopsis) children.push(ui.text(ui.softEsc(synopsis)));
  children.push(ui.divider());

  // The facts, one tidy line each.
  const facts = [];
  if (isManga) {
    const ch = media.chapters ? `**${media.chapters}** chapters` : media.status === 'RELEASING' ? 'Ongoing' : 'Length unknown';
    facts.push(`📖 ${ch}${media.volumes ? ` · ${media.volumes} volumes` : ''}`);
  } else {
    let eps;
    if (media.episodes) eps = `**${media.episodes}** episode${media.episodes === 1 ? '' : 's'}`;
    else if (media.nextAiringEpisode) eps = `**${media.nextAiringEpisode.episode - 1}** episodes so far`;
    else eps = 'Episodes unknown';
    facts.push(`📺 ${eps}${media.duration ? ` · ${media.duration} min${media.episodes === 1 ? '' : ' each'}` : ''}`);
  }
  const start = formatDate(media.startDate);
  const end = formatDate(media.endDate);
  const seasonTag = media.season && media.seasonYear ? `${prettyEnum(media.season)} ${media.seasonYear}` : null;
  if (start || seasonTag) {
    const range = start ? (end && end !== start ? `${start} → ${end}` : media.status === 'RELEASING' ? `${start} → now` : start) : null;
    facts.push(`📅 ${[seasonTag ? `**${seasonTag}**` : null, range].filter(Boolean).join(' · ')}`);
  }
  if (media.nextAiringEpisode?.airingAt) facts.push(`⏭️ Episode **${media.nextAiringEpisode.episode}** airs <t:${media.nextAiringEpisode.airingAt}:R>`);
  const studio = media.studios?.nodes?.[0];
  const src = media.source ? `📚 From ${prettyEnum(media.source).toLowerCase()}` : null;
  if (studio || src) facts.push([studio ? `🏢 ${studio.siteUrl ? `[${ui.esc(studio.name)}](${studio.siteUrl})` : ui.esc(studio.name)}` : null, src].filter(Boolean).join('  ·  '));
  const pop = (media.rankings || []).find((r) => r.type === 'POPULAR' && r.allTime);
  const score = [
    typeof media.averageScore === 'number' ? `⭐ **${(media.averageScore / 10).toFixed(1)}**/10` : null,
    pop && pop.rank <= 500 ? `❤️ #${pop.rank} most popular` : null,
    media.popularity ? `👥 ${media.popularity.toLocaleString('en-US')} members` : null,
  ].filter(Boolean);
  if (score.length) facts.push(score.join('  ·  '));
  children.push(ui.text(facts.join('\n')));

  const tags = pickTags(media.tags, media.genres, 6, { minRank: 50 });
  if (tags.length) children.push(ui.text(`🏷️ ${tags.map((t) => `\`${t}\``).join(' ')}`));

  // Main cast: portraits side by side.
  const cast = (media.characters?.edges || []).filter((e) => e.node);
  if (cast.length) {
    children.push(ui.divider());
    children.push(ui.text(ui.label('Main cast')));
    const g = ui.gallery(cast.map((e) => ({ url: e.node.image?.large, description: `${e.node.name.full}${e.voiceActors?.[0] ? ` · CV ${e.voiceActors[0].name.full}` : ''}` })));
    if (g) children.push(g);
    children.push(
      ui.text(
        cast
          .map((e) => {
            const name = e.node.siteUrl ? `[${ui.esc(e.node.name.full)}](${e.node.siteUrl})` : ui.esc(e.node.name.full);
            const va = e.voiceActors?.[0]?.name?.full;
            return `**${name}** · ${prettyEnum(e.role) || 'Character'}${va ? ` · -# CV ${ui.esc(va)}` : ''}`.replace(' · -# ', ' · ');
          })
          .join('\n')
      )
    );
  }

  // Link buttons
  const buttons = [];
  const trailer = trailerUrl(media.trailer);
  buttons.push(ui.linkButton(trailer || `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} trailer`)}`, trailer ? 'Trailer' : 'Find trailer', '🎬'));
  const stream = (media.externalLinks || []).find((l) => l.type === 'STREAMING' && !l.isDisabled && /^https?:\/\//.test(l.url));
  if (stream) buttons.push(ui.linkButton(stream.url, truncate(`Watch on ${stream.site}`, 80), '📡'));
  buttons.push(ui.linkButton(media.siteUrl, 'AniList', '🔗'));
  if (media.idMal) buttons.push(ui.linkButton(`https://myanimelist.net/${isManga ? 'manga' : 'anime'}/${media.idMal}`, 'MyAnimeList'));
  children.push(ui.divider());
  children.push(ui.actionRow(buttons));
  if (extra.actions) children.push(extra.actions);
  children.push(ui.text(`-# ${extra.footer || 'Only you can see this · Data from AniList'}`));

  return ui.fit([ui.card(color, children)]);
}

module.exports = { buildMoreInfo };
