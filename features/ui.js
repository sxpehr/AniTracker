const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

/* ---------------------------------------------------------------------------
 * AniTracker UI kit — built on Discord's "Components V2" layout system.
 *
 * Compared to classic embeds this gives us: real image galleries (up to 10
 * covers in a grid), rows with a cover/avatar thumbnail beside the text,
 * dividers with spacing, big markdown headings, and buttons/menus *inside*
 * the card — so profiles and settings can feel like actual pages.
 *
 * Hard limits Discord enforces per message (checked by fit()):
 *   • 40 components total (every text block, row, button, thumbnail counts)
 *   • 4000 characters of text across all text blocks
 * ------------------------------------------------------------------------- */

const ANILIST_BLUE = 0x3db4f2; // menus / settings / system screens
const ANILIST_NAVY = 0x0b1622;
const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_COMPONENTS = 40;
const MAX_TEXT = 4000;

const text = (content) => new TextDisplayBuilder().setContent(String(content).slice(0, MAX_TEXT));

const divider = (big = false) => new SeparatorBuilder().setDivider(true).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
const gap = (big = false) => new SeparatorBuilder().setDivider(false).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u);
}

// A row: text on the left, a picture (or a button) on the right.
function section(lines, accessory) {
  const s = new SectionBuilder().addTextDisplayComponents(...[].concat(lines).filter(Boolean).slice(0, 3).map((l) => text(l)));
  if (accessory instanceof ButtonBuilder) s.setButtonAccessory(accessory);
  else if (isHttpUrl(accessory)) s.setThumbnailAccessory(new ThumbnailBuilder().setURL(accessory));
  else return null; // a Section must have an accessory — caller falls back to plain text
  return s;
}

// Section when there's an image, plain text otherwise.
function row(lines, imageOrButton) {
  const s = section(lines, imageOrButton);
  return s || text([].concat(lines).filter(Boolean).join('\n'));
}

function gallery(items) {
  const valid = items.filter((i) => isHttpUrl(i.url)).slice(0, 10);
  if (!valid.length) return null;
  return new MediaGalleryBuilder().addItems(
    ...valid.map((i) => {
      const item = new MediaGalleryItemBuilder().setURL(i.url);
      if (i.description) item.setDescription(String(i.description).slice(0, 256));
      if (i.spoiler) item.setSpoiler(true);
      return item;
    })
  );
}

// Cover grids. A single portrait cover in a gallery renders huge, so with one
// item we either skip the grid (the list below already names it) or show a
// compact row with a thumbnail.
function coverGallery(items, { single = 'skip' } = {}) {
  const valid = items.filter((i) => isHttpUrl(i.url));
  if (valid.length >= 2) return gallery(valid);
  if (valid.length === 1 && single === 'row') return section([`**${esc(valid[0].description || '')}**`], valid[0].url);
  return null;
}

function button(customId, label, { style = ButtonStyle.Secondary, emoji, disabled = false } = {}) {
  const b = new ButtonBuilder().setCustomId(customId).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(String(label).slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}

function linkButton(url, label, emoji) {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(String(label).slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}

function actionRow(...components) {
  const flat = components.flat().filter(Boolean);
  if (!flat.length) return null;
  return new ActionRowBuilder().addComponents(...flat.slice(0, 5));
}

function select(customId, placeholder, options, { min = 1, max = 1, disabled = false } = {}) {
  const opts = options.slice(0, 25).map((o) => ({
    label: String(o.label).slice(0, 100),
    value: String(o.value).slice(0, 100),
    description: o.description ? String(o.description).slice(0, 100) : undefined,
    emoji: o.emoji || undefined,
    default: Boolean(o.default),
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(String(placeholder).slice(0, 150))
    .setMinValues(Math.min(min, opts.length))
    .setMaxValues(Math.max(1, Math.min(max, opts.length)))
    .setDisabled(disabled || !opts.length)
    .addOptions(opts.length ? opts : [{ label: 'Nothing here yet', value: '_none' }]);
  return new ActionRowBuilder().addComponents(menu);
}

/* ------------------------------ composition ------------------------------ */

// Container from a list of children (nulls skipped). Children can be marked
// optional via { optional: true, component } so fit() can drop them to stay
// within Discord's limits instead of failing the whole message.
function card(accent, children) {
  return { accent, children: children.filter(Boolean) };
}

function unwrap(child) {
  return child && child.component ? child.component : child;
}

function countJson(c) {
  let n = 1;
  if (Array.isArray(c.components)) for (const x of c.components) n += countJson(x);
  if (c.accessory) n += countJson(c.accessory);
  return n;
}

function textJson(c) {
  let t = c.type === 10 ? (c.content || '').length : 0;
  if (Array.isArray(c.components)) for (const x of c.components) t += textJson(x);
  if (c.accessory) t += textJson(c.accessory);
  return t;
}

// Builds the final message payload from cards (+ optional top-level rows),
// dropping optional children (last first) until it fits Discord's limits.
function fit(cards, { rows = [], files } = {}) {
  const entries = []; // { cardIndex, childIndex, optional, json }
  cards.forEach((cd, ci) =>
    cd.children.forEach((ch, i) => {
      const comp = unwrap(ch);
      entries.push({
        ci,
        i,
        optional: Boolean(ch && ch.optional),
        priority: ch?.priority ?? 5,
        group: Boolean(ch?.group),
        unit: ch?.unit || null,
        memberOf: ch?.memberOf || null,
        json: comp.toJSON(),
      });
    })
  );
  const rowJson = rows.filter(Boolean).map((r) => r.toJSON());
  const total = () =>
    cards.length +
    entries.filter((e) => !e.dropped).reduce((s, e) => s + countJson(e.json), 0) +
    rowJson.reduce((s, r) => s + countJson(r), 0);
  const chars = () => entries.filter((e) => !e.dropped).reduce((s, e) => s + textJson(e.json), 0);

  // Drop optional pieces lowest-priority first. "group" pieces (like the
  // dividers between profile sections) go all together, so spacing stays
  // consistent instead of disappearing from only the bottom half.
  const over = () => total() > MAX_COMPONENTS || chars() > MAX_TEXT;
  const levels = [...new Set(entries.filter((e) => e.optional).map((e) => e.priority))].sort((a, b) => a - b);
  for (const level of levels) {
    if (!over()) break;
    const group = entries.filter((e) => e.optional && e.priority === level && !e.dropped);
    if (group.some((e) => e.group)) group.forEach((e) => (e.dropped = true));
    else
      for (let k = group.length - 1; k >= 0 && over(); k--) {
        if (group[k].dropped) continue;
        group[k].dropped = true;
        // pieces sharing a "unit" (e.g. one whole profile section) leave together
        const u = group[k].unit;
        if (u) entries.forEach((e) => (e.unit === u || e.memberOf === u) && (e.dropped = true));
      }
  }
  if (total() > MAX_COMPONENTS || chars() > MAX_TEXT) {
    console.warn(`[ui] message still over limits after trimming (${total()} components, ${chars()} chars)`);
  }

  const components = cards.map((cd, ci) => {
    const c = new ContainerBuilder();
    if (typeof cd.accent === 'number') c.setAccentColor(cd.accent);
    for (const e of entries.filter((x) => x.ci === ci && !x.dropped)) {
      const comp = unwrap(cd.children[e.i]);
      if (comp instanceof TextDisplayBuilder) c.addTextDisplayComponents(comp);
      else if (comp instanceof SectionBuilder) c.addSectionComponents(comp);
      else if (comp instanceof MediaGalleryBuilder) c.addMediaGalleryComponents(comp);
      else if (comp instanceof SeparatorBuilder) c.addSeparatorComponents(comp);
      else if (comp instanceof ActionRowBuilder) c.addActionRowComponents(comp);
    }
    return c;
  });

  const payload = { components: [...components, ...rows.filter(Boolean)], flags: V2, allowedMentions: { parse: [] } };
  if (files) payload.files = files;
  return payload;
}

const optional = (component, { priority = 5, group = false, unit = null } = {}) => {
  if (!component) return null;
  // Already optional (with its own priority): keep that, and just note which
  // unit it belongs to so it leaves if its whole unit is dropped.
  if (component.optional) return { ...component, memberOf: unit || component.memberOf || null };
  return { optional: true, component, priority, group, unit };
};

/* ------------------------------ typography ------------------------------ */

const label = (s) => `-# ${s.toUpperCase()}`; // small caps-style section label
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

function clip(s, max) {
  if (!s) return '';
  s = String(s);
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// Escapes markdown so user-written text can't break the layout.
function esc(s) {
  return String(s ?? '').replace(/([\\*_`~|>#\[\]()-])/g, '\\$1');
}

// Light escape for multi-line user text (bios, reviews): keeps line breaks and
// basic emphasis, but neutralises headings/quotes/masked links that would
// break the card layout.
function softEsc(s) {
  return String(s ?? '')
    .replace(/^(\s*)(#{1,3}\s|-#\s|>\s?)/gm, '$1\\$2')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/@(everyone|here)/g, '@​$1');
}

function bar(value, max, width = 10) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function sparkline(values) {
  const ticks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 0);
  if (!max) return values.map(() => '▁').join('');
  return values.map((v) => ticks[Math.min(7, Math.round((v / max) * 7))]).join('');
}

function stars10(score) {
  // 10-point score -> 5 stars with halves: 9 -> ★★★★½
  const halves = Math.round(Math.max(0, Math.min(10, score)));
  const full = Math.floor(halves / 2);
  return '★'.repeat(full) + (halves % 2 ? '½' : '') + '☆'.repeat(5 - full - (halves % 2));
}

function relTime(date) {
  const t = Math.floor(new Date(date).getTime() / 1000);
  return Number.isFinite(t) ? `<t:${t}:R>` : '';
}

function shortDate(date) {
  const t = Math.floor(new Date(date).getTime() / 1000);
  return Number.isFinite(t) ? `<t:${t}:D>` : '';
}

function hours(minutes) {
  const h = minutes / 60;
  return h >= 100 ? num(Math.round(h)) : h.toFixed(1).replace(/\.0$/, '');
}

module.exports = {
  ANILIST_BLUE,
  ANILIST_NAVY,
  V2,
  EPHEMERAL,
  ButtonStyle,
  text,
  divider,
  gap,
  section,
  row,
  gallery,
  coverGallery,
  button,
  linkButton,
  actionRow,
  select,
  card,
  fit,
  optional,
  label,
  num,
  clip,
  esc,
  softEsc,
  bar,
  sparkline,
  stars10,
  relTime,
  shortDate,
  hours,
  isHttpUrl,
  countJson,
};
