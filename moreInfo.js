const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

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
 * @param media  result of anilist.getMediaDetails
 * @param extra  { seasonNumber, totalSeasons }
 */
function buildMoreInfo(media, extra = {}) {
  const isManga = media.type === 'MANGA';
  const title = titleOf(media);
  const color = hexToInt(media.coverImage?.color) || DEFAULT_COLOR;

  const headerBits = [FORMAT_LABELS[media.format] || prettyEnum(media.format), STATUS_LABELS[media.status]].filter(Boolean);

  // Score, genres and popularity are already on the activity post, so they're
  // left out; the full synopsis is here (the post only shows a short teaser).
  const altTitle = media.title?.native || (media.title?.english && media.title?.romaji !== media.title?.english ? media.title.romaji : null);

  const main = new EmbedBuilder()
    .setColor(color)
    .setTitle(truncate(title, 256))
    .setURL(media.siteUrl)
    .setFooter({ text: 'Only you can see this • Data from AniList' });

  if (headerBits.length) main.setAuthor({ name: headerBits.join('  •  ') });
  const synopsis = cleanDescription(media.description, 900);
  const desc = [altTitle ? `*${truncate(altTitle, 200)}*` : null, synopsis || null].filter(Boolean).join('\n\n');
  if (desc) main.setDescription(truncate(desc, 4000));
  if (media.bannerImage) main.setImage(media.bannerImage);

  const fields = [];

  // Row 1: length · seasons · dates
  if (isManga) {
    const ch = media.chapters ? `${media.chapters} chapters` : media.status === 'RELEASING' ? 'Ongoing' : 'Unknown';
    const vol = media.volumes ? `${media.volumes} volumes` : null;
    fields.push({ name: '📖 Length', value: [ch, vol].filter(Boolean).join('\n'), inline: true });
  } else {
    let eps;
    if (media.episodes) eps = `${media.episodes} episode${media.episodes === 1 ? '' : 's'}`;
    else if (media.nextAiringEpisode) eps = `${media.nextAiringEpisode.episode - 1} so far`;
    else eps = 'Unknown';
    const dur = media.duration ? `${media.duration} min${media.episodes === 1 ? '' : ' each'}` : null;
    fields.push({ name: '📺 Episodes', value: [eps, dur].filter(Boolean).join('\n'), inline: true });
  }

  if (!isManga && extra.totalSeasons) {
    const value =
      extra.seasonNumber && extra.totalSeasons > 1
        ? `Season ${extra.seasonNumber} of ${extra.totalSeasons}`
        : `${extra.totalSeasons} season${extra.totalSeasons === 1 ? '' : 's'}`;
    fields.push({ name: '🗂️ Seasons', value, inline: true });
  }

  const start = formatDate(media.startDate);
  const end = formatDate(media.endDate);
  const seasonTag = media.season && media.seasonYear ? `${prettyEnum(media.season)} ${media.seasonYear}` : null;
  if (start || seasonTag) {
    const range = start ? (end && end !== start ? `${start} → ${end}` : media.status === 'RELEASING' ? `${start} → now` : start) : null;
    fields.push({ name: isManga ? '📅 Published' : '📅 Aired', value: [seasonTag, range].filter(Boolean).join('\n'), inline: true });
  }

  // Row 2: next episode · studio · source
  if (media.nextAiringEpisode?.airingAt) {
    fields.push({ name: '⏭️ Next episode', value: `Ep ${media.nextAiringEpisode.episode}\n<t:${media.nextAiringEpisode.airingAt}:R>`, inline: true });
  }
  const studio = media.studios?.nodes?.[0];
  if (studio) fields.push({ name: '🏢 Studio', value: studio.siteUrl ? `[${studio.name}](${studio.siteUrl})` : studio.name, inline: true });
  if (media.source) fields.push({ name: '📚 Source', value: prettyEnum(media.source), inline: true });

  // Full width: tags (spoiler-free, and only ones AniList rates as relevant)
  const tags = (media.tags || [])
    .filter((t) => !t.isMediaSpoiler && !t.isGeneralSpoiler && t.rank >= 60)
    .slice(0, 6)
    .map((t) => t.name);
  if (tags.length) fields.push({ name: '🏷️ Tags', value: tags.join(' · '), inline: false });

  main.addFields(fields.slice(0, 25));

  const embeds = [main];

  // Main cast — Discord merges embeds that share the same URL into one
  // image gallery, so the three character portraits show side by side.
  const cast = (media.characters?.edges || []).filter((e) => e.node);
  if (cast.length) {
    const castUrl = `${media.siteUrl}/characters`;
    const lines = cast.map((e) => {
      const name = e.node.siteUrl ? `[${e.node.name.full}](${e.node.siteUrl})` : e.node.name.full;
      const va = e.voiceActors?.[0]?.name?.full;
      return `**${name}** · ${prettyEnum(e.role) || 'Character'}${va ? `\n-# CV: ${va}` : ''}`;
    });
    const castEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle('🎭 Main Cast')
      .setURL(castUrl)
      .setDescription(lines.join('\n'));
    const images = cast.map((e) => e.node.image?.large).filter(Boolean);
    if (images[0]) castEmbed.setImage(images[0]);
    embeds.push(castEmbed);
    for (const img of images.slice(1, 4)) {
      embeds.push(new EmbedBuilder().setURL(castUrl).setImage(img));
    }
  }

  // Link buttons
  const buttons = [];
  const trailer = trailerUrl(media.trailer);
  buttons.push(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setEmoji('🎬')
      .setLabel(trailer ? 'Trailer' : 'Find trailer')
      .setURL(trailer || `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} trailer`)}`)
  );

  const stream = (media.externalLinks || []).find((l) => l.type === 'STREAMING' && !l.isDisabled && /^https?:\/\//.test(l.url));
  if (stream) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setEmoji('📡')
        .setLabel(truncate(`Watch on ${stream.site}`, 80))
        .setURL(stream.url)
    );
  }

  buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🔗').setLabel('AniList').setURL(media.siteUrl));
  if (media.idMal) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('MyAnimeList')
        .setURL(`https://myanimelist.net/${isManga ? 'manga' : 'anime'}/${media.idMal}`)
    );
  }

  return { embeds, components: [new ActionRowBuilder().addComponents(buttons.slice(0, 5))] };
}

module.exports = { buildMoreInfo };
