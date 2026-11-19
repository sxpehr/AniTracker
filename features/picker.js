const { ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder } = require('discord.js');
const ui = require('./ui');
const { searchAnime, titleOf } = require('./anilistSocial');

/* ---------------------------------------------------------------------------
 * Anime picker: "type a name → pick the right result".
 *
 * Discord forms can't autocomplete, so: a small form asks for the name, then
 * the results appear as a menu with years/format/episodes so the right
 * season is easy to spot. Whatever asked for the pick (a purpose) gets the
 * chosen anime back. Used by: featured anime, favorite opening, adding to
 * collections, In Rotation, recommendations.
 *
 *   modal id:   q:<purpose>:<arg>
 *   menu id:    qs:<purpose>:<arg>
 * ------------------------------------------------------------------------- */

const purposes = new Map(); // name -> { title, onPick(interaction, media, arg), onCancel(interaction, arg) }

function registerPurpose(name, def) {
  purposes.set(name, def);
}

function openSearch(interaction, purpose, arg = '-', { title, placeholder } = {}) {
  const def = purposes.get(purpose) || {};
  const input = new TextInputBuilder()
    .setCustomId('q')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder || 'e.g. Frieren, Mob Psycho 100, Dandadan…')
    .setMinLength(2)
    .setMaxLength(80)
    .setRequired(true);
  const modal = new ModalBuilder()
    .setCustomId(`q:${purpose}:${arg}`.slice(0, 100))
    .setTitle((title || def.title || 'Find an anime').slice(0, 45))
    .addLabelComponents(new LabelBuilder().setLabel('Anime name').setDescription('Search AniList — you pick the exact entry next').setTextInputComponent(input));
  return interaction.showModal(modal);
}

function describe(m) {
  const bits = [m.seasonYear, m.format && m.format.replace('_', ' '), m.episodes ? `${m.episodes} eps` : null].filter(Boolean);
  return bits.join(' · ') || 'AniList';
}

function resultsView(purpose, arg, query, results) {
  const def = purposes.get(purpose) || {};
  const children = [ui.text(`### 🔎 ${def.title || 'Find an anime'}\n-# Results for “${ui.esc(ui.clip(query, 60))}” — pick the right one`)];
  if (!results.length) {
    children.push(ui.text('No matches on AniList. Try the English or Japanese title, or fewer words.'));
  } else {
    const covers = results.slice(0, 4).map((m) => ({ url: m.coverImage?.large || m.coverImage?.medium, description: titleOf(m) }));
    const g = ui.coverGallery(covers);
    if (g) children.push(g);
    children.push(
      ui.select(
        `qs:${purpose}:${arg}`.slice(0, 100),
        'Choose the anime…',
        results.slice(0, 25).map((m) => ({ label: ui.clip(titleOf(m), 100), value: String(m.id), description: describe(m) }))
      )
    );
  }
  children.push(ui.actionRow(ui.button(`qx:${purpose}:${arg}`.slice(0, 100), 'Cancel', { emoji: '↩️' }), ui.button(`qr:${purpose}:${arg}`.slice(0, 100), 'Search again', { emoji: '🔎' })));
  return ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
}

async function onModal(interaction) {
  const [, purpose, arg] = interaction.customId.split(':');
  const query = interaction.fields.getTextInputValue('q');
  // Acknowledge first — AniList can take a few seconds and Discord only waits 3.
  const inPanel = interaction.isFromMessage?.() && interaction.message?.flags?.has?.(ui.EPHEMERAL);
  try {
    if (inPanel) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: ui.EPHEMERAL });
  } catch (e) {
    console.error('Search defer failed:', e.message);
    return;
  }
  let results = [];
  try {
    results = await searchAnime(query, 15);
  } catch (e) {
    console.error('Anime search failed:', e.message);
  }
  await interaction.editReply(resultsView(purpose, arg, query, results)).catch((e) => console.error('Failed to show search results:', e.message));
}

async function onComponent(interaction) {
  const [kind, purpose, arg] = interaction.customId.split(':');
  const def = purposes.get(purpose);
  if (!def) return;
  if (kind === 'qr') return openSearch(interaction, purpose, arg);
  if (kind === 'qx') return def.onCancel ? def.onCancel(interaction, arg) : interaction.update(ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text('Cancelled.')])])).catch(() => {});
  if (kind === 'qs') {
    const id = parseInt(interaction.values[0], 10);
    if (!id) return;
    await interaction.deferUpdate().catch(() => {}); // lookups below can be slow
    const { getMediaLite } = require('./anilistSocial');
    const media = await getMediaLite(id).catch(() => null);
    if (!media) {
      await interaction.followUp({ content: '⚠️ AniList isn’t responding right now — try again in a moment.', flags: ui.EPHEMERAL }).catch(() => {});
      return;
    }
    return def.onPick(interaction, media, arg); // handlers edit the (already acknowledged) panel
  }
}

module.exports = { registerPurpose, openSearch, onModal, onComponent, resultsView };
