const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// The private "More Info" panel for one movie or show. Pure formatting;
// fetching happens in index.js.

const DEFAULT_COLOR = 0x3db4f2;

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function kindLabel(kind) {
  return kind === 'movie' ? '🎬 Movie' : '📺 TV show';
}

function buildMoreInfo(title, extra = {}) {
  const embed = new EmbedBuilder()
    .setColor(extra.color ?? DEFAULT_COLOR)
    .setTitle(`${title.title}${title.year ? ` (${title.year})` : ''}`)
    .setURL(title.siteUrl);

  const facts = [kindLabel(title.kind)];
  if (title.rating) facts.push(`⭐ ${title.rating.toFixed(1)}/10 (Simkl)`);
  if (title.genres.length) facts.push(`🎭 ${title.genres.slice(0, 3).join(', ')}`);
  if (extra.runtime) facts.push(`⏱️ ${extra.runtime} min`);
  if (title.kind === 'show' && title.episodes) facts.push(`🎞️ ${title.episodes} episodes`);
  if (title.status) facts.push(`📡 ${String(title.status).replace(/^./, (c) => c.toUpperCase())}`);

  const lines = [facts.join('  •  ')];
  if (title.overview) lines.push('', truncate(title.overview, 600));
  embed.setDescription(lines.join('\n'));

  if (title.poster) embed.setImage(title.poster);

  const fields = [];
  if (extra.network) fields.push({ name: 'Network', value: extra.network, inline: true });
  if (extra.cast?.length) fields.push({ name: 'Cast', value: extra.cast.slice(0, 5).join(', '), inline: false });
  if (fields.length) embed.addFields(fields);

  const links = [];
  if (title.imdb) links.push(`[IMDb](https://www.imdb.com/title/${title.imdb})`);
  if (extra.trailerUrl) links.push(`[Trailer](${extra.trailerUrl})`);
  links.push(`[Simkl](${title.siteUrl})`);
  embed.addFields({ name: 'Links', value: links.join(' · '), inline: false });

  embed.setFooter({ text: 'Only you can see this • Data from Simkl' });
  return { embeds: [embed], components: [] };
}

module.exports = { buildMoreInfo, DEFAULT_COLOR };
