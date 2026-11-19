const { ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, TextDisplayBuilder, StringSelectMenuBuilder, PermissionFlagsBits } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { THEMES, paletteFor, parseHex, hex, bannerUrlFor } = require('./themes');
const { ctx } = require('./ctx');
const { snapshot, getOpenings, titleOf } = require('./anilistSocial');
const picker = require('./picker');
const statsUi = require('./statsUi');

/* ---------------------------------------------------------------------------
 * /settings — the customisation studio.
 *
 *  ┌ AniList-blue control panel ─────────────────────────┐
 *  │ ⚙️ Settings › 🎨 Appearance        ● unsaved changes │
 *  │ [ category menu ]                                    │
 *  │ settings rows: label · current value · [Edit]        │
 *  │ [💾 Save] [↩️ Discard] [👁️ Full preview]             │
 *  └──────────────────────────────────────────────────────┘
 *  ┌ live preview, in YOUR theme colours ─────────────────┐
 *  │ banner · avatar · name · tagline · featured          │
 *  └──────────────────────────────────────────────────────┘
 *
 * Every change goes into a draft first and the preview updates instantly;
 * nothing is applied until Save. (Server settings apply immediately.)
 *
 * ids: s:open · s:cat · s:theme · s:banner · s:sections · s:layout · s:feat
 *      s:style · s:color · s:show · s:auto · s:vis · s:hide · s:tz · s:recap
 *      s:spoil · s:lb · s:save · s:discard · s:preview · s:postpreview
 *      s:edit:<text|color|bannerurl|featnote|opmanual> · s:op:<mediaId>
 * ------------------------------------------------------------------------- */

const CATEGORIES = {
  look: { label: 'Appearance', emoji: '🎨', description: 'Theme, colours and banner' },
  profile: { label: 'Profile', emoji: '👤', description: 'Name, tagline, bio, featured anime, opening' },
  showcase: { label: 'Showcase', emoji: '🧩', description: 'Choose what your profile shows, and the layout' },
  activity: { label: 'Activity posts', emoji: '📡', description: 'How your watch updates look in servers' },
  privacy: { label: 'Privacy', emoji: '🔒', description: 'Who can see what' },
  more: { label: 'Stats & reviews', emoji: '📊', description: 'Time zone, monthly recap, spoilers' },
  server: { label: 'Server', emoji: '🛡️', description: 'Leaderboards for this server (managers)' },
};

const DRAFT_FIELDS = ['profile', 'activity', 'privacy', 'prefs'];
const drafts = new Map(); // userId -> { data, dirty, cat, at, autoPost }
const DRAFT_TTL = 45 * 60 * 1000;

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

async function getDraft(userId) {
  const now = Date.now();
  for (const [k, v] of drafts) if (now - v.at > DRAFT_TTL) drafts.delete(k);
  let d = drafts.get(userId);
  if (!d) {
    const s = await ctx.loadSocial();
    const u = social.peekUser(s, userId);
    d = { data: Object.fromEntries(DRAFT_FIELDS.map((f) => [f, clone(u[f])])), dirty: false, cat: 'look', at: now, autoPost: undefined };
    drafts.set(userId, d);
  }
  d.at = now;
  return d;
}

// A full user object = saved collections + draft look/settings (for previews).
async function draftUser(userId, d) {
  const s = await ctx.loadSocial();
  const saved = social.peekUser(s, userId);
  return { ...saved, ...clone(d.data) };
}

function changed(d) {
  d.dirty = true;
}

/* ------------------------------- rendering ------------------------------- */

function rowItem(title, value, buttonId, buttonLabel, emoji = '✏️', style) {
  return ui.section([`**${title}**`, value], ui.button(buttonId, buttonLabel, { emoji, style }));
}

function quote(v, empty = 'Not set') {
  return v ? `> ${ui.softEsc(ui.clip(v, 180)).replace(/\n/g, '\n> ')}` : `-# ${empty}`;
}

async function panelBlocks(userId, d, interaction) {
  const p = d.data.profile;
  const cat = d.cat;
  const blocks = [];

  if (cat === 'look') {
    const pal = paletteFor(p);
    const custom = Number.isInteger(p.accent) || Number.isInteger(p.background) || Number.isInteger(p.accent2);
    blocks.push(ui.text(ui.label('Theme')));
    blocks.push(
      ui.select(
        's:theme',
        'Pick a theme…',
        [
          ...Object.entries(THEMES).map(([k, t]) => ({ label: t.name, value: k, emoji: t.emoji, description: `${t.blurb} · ${hex(t.accent)}`, default: p.theme === k && !custom })),
          { label: 'Custom colours…', value: '_custom', emoji: '🎨', description: 'Pick your own accent, highlight and background', default: custom },
        ]
      )
    );
    blocks.push(
      rowItem(
        'Colours',
        `-# accent \`${hex(pal.accent)}\` · highlight \`${hex(pal.accent2)}\` · background \`${hex(pal.bg)}\`${custom ? ' · custom' : ''}`,
        's:edit:color',
        'Custom…',
        '🎨'
      )
    );
    const modes = {
      theme: ['Theme art', '✨', 'A banner painted from your theme colours'],
      featured: ['Featured anime', '🎞️', 'Your featured anime’s banner, tinted to your theme'],
      url: ['My own image', '🖼️', 'Any https image link'],
      none: ['No banner', '➖', 'Keep it compact'],
    };
    blocks.push(ui.text(ui.label('Banner')));
    blocks.push(
      ui.select(
        's:banner',
        'Banner style…',
        Object.entries(modes).map(([k, [l, e, desc]]) => ({ label: l, value: k, emoji: e, description: desc, default: (p.bannerMode || 'theme') === k }))
      )
    );
    if (p.bannerMode === 'url') blocks.push(rowItem('Banner image', p.bannerUrl ? `-# ${ui.esc(ui.clip(p.bannerUrl, 90))}` : '-# Paste an https image link', 's:edit:bannerurl', 'Set link', '🔗'));
    if (p.bannerMode === 'featured' && !p.featured) blocks.push(ui.text('-# ⚠️ Pick a featured anime in **Profile** first — until then the theme banner is used.'));
  }

  if (cat === 'profile') {
    blocks.push(
      rowItem(
        'Name, tagline & bio',
        [`-# ${ui.esc(p.displayName || 'Using your Discord name')}${p.tagline ? ` · *${ui.softEsc(ui.clip(p.tagline, 60))}*` : ''}`, quote(p.bio, 'No bio yet')].join('\n'),
        's:edit:text',
        'Edit',
        '✏️'
      )
    );
    const f = p.featured;
    blocks.push(rowItem('Featured anime', f ? `-# [${ui.esc(f.title)}](${f.siteUrl})${f.note ? ` — *${ui.softEsc(ui.clip(f.note, 80))}*` : ''}` : '-# None — pick one below', 's:edit:featnote', 'Note', '📝'));
    const s = await ctx.loadSocial();
    const favs = social.peekUser(s, userId).favorites.slice(0, 22);
    blocks.push(ui.text(ui.label('Choose your featured anime')));
    blocks.push(
      ui.select('s:feat', f ? 'Change featured anime…' : 'Feature an anime…', [
        ...favs.map((e) => ({ label: ui.clip(e.title, 100), value: String(e.mediaId), emoji: '⭐', description: 'From your favorites', default: f?.mediaId === e.mediaId })),
        { label: 'Search AniList…', value: '_search', emoji: '🔎', description: 'Feature any anime' },
        ...(f ? [{ label: 'Remove featured anime', value: '_none', emoji: '✖️' }] : []),
      ])
    );
    const o = p.opening;
    blocks.push(
      rowItem(
        'Favorite opening',
        o ? `-# 🎵 **${ui.esc(o.song || o.slug)}**${o.artists?.length ? ` — ${ui.esc(o.artists.join(', '))}` : ''} · ${ui.esc(ui.clip(o.animeTitle, 40))} ${o.slug}` : '-# Pick the OP you could listen to forever',
        's:pickop',
        o ? 'Change' : 'Choose',
        '🎵'
      )
    );
  }

  if (cat === 'showcase') {
    blocks.push(ui.text('-# Pick what appears on your profile. Your **layout** decides the order.'));
    blocks.push(ui.text(ui.label('Show on my profile')));
    blocks.push(
      ui.select(
        's:sections',
        'Profile sections (pick any)…',
        Object.entries(social.SECTIONS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, description: v.description, default: p.sections.includes(k) })),
        { min: 0, max: Object.keys(social.SECTIONS).length }
      )
    );
    blocks.push(ui.text(ui.label('Layout')));
    blocks.push(
      ui.select(
        's:layout',
        'Layout…',
        Object.entries(social.LAYOUTS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, description: v.description, default: p.layout === k }))
      )
    );
    const order = (social.LAYOUTS[p.layout] || social.LAYOUTS.classic).order.filter((k) => p.sections.includes(k));
    blocks.push(ui.text(`-# Order: ${order.length ? order.map((k) => `${social.SECTIONS[k].emoji} ${social.SECTIONS[k].label}`).join('  →  ') : 'nothing selected'}`));
  }

  if (cat === 'activity') {
    const a = d.data.activity;
    const core = await ctx.loadData();
    const linked = core.linkedAccounts[userId];
    const autoPost = d.autoPost !== undefined ? d.autoPost : linked ? !core.trackingOptOut[String(linked.anilistId)] : null;
    if (linked) {
      blocks.push(
        ui.section(
          ['**Auto-post my activity**', autoPost ? '-# 🟢 On — your updates post in servers tracking you' : '-# 🔴 Off — nothing posts (your stats still update privately)'],
          ui.button('s:auto', autoPost ? 'Turn off' : 'Turn on', { emoji: autoPost ? '🔴' : '🟢', style: autoPost ? ui.ButtonStyle.Danger : ui.ButtonStyle.Success })
        )
      );
    } else {
      blocks.push(ui.text('-# 🔐 Link your AniList with `/signin` to control auto-posting. The styles below still apply to profiles you track.'));
    }
    blocks.push(ui.text(ui.label('Post style')));
    blocks.push(
      ui.select('s:style', 'Post style…', [
        { label: 'Full', value: 'full', emoji: '🖼️', description: 'Big cover art, synopsis — the classic look', default: a.style === 'full' },
        { label: 'Compact', value: 'compact', emoji: '🗒️', description: 'Small cover thumbnail, tighter text', default: a.style === 'compact' },
        { label: 'Minimal', value: 'minimal', emoji: '➖', description: 'Just what you watched', default: a.style === 'minimal' },
      ])
    );
    blocks.push(ui.text(ui.label('Post colour')));
    blocks.push(
      ui.select('s:color', 'Post colour…', [
        { label: 'Match the cover art', value: 'cover', emoji: '🖌️', description: 'Changes with every anime (default)', default: a.color === 'cover' },
        { label: 'My theme accent', value: 'theme', emoji: '🎨', description: `Always ${hex(paletteFor(p).accent)}`, default: a.color === 'theme' },
        { label: 'AniList blue', value: 'anilist', emoji: '🟦', description: '#3DB4F2', default: a.color === 'anilist' },
      ])
    );
    blocks.push(ui.text(ui.label('Details on each post')));
    blocks.push(
      ui.select(
        's:show',
        'Show on posts (pick any)…',
        Object.entries(social.ACTIVITY_FIELDS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, default: a.show.includes(k) })),
        { min: 0, max: Object.keys(social.ACTIVITY_FIELDS).length }
      )
    );
    blocks.push(ui.text('-# Tap **📡 Preview a post** to see your next activity post exactly as it’ll look.'));
  }

  if (cat === 'privacy') {
    const pr = d.data.privacy;
    blocks.push(ui.text(ui.label('Profile visibility')));
    blocks.push(
      ui.select('s:vis', 'Profile visibility…', [
        { label: 'Public', value: 'public', emoji: '🌍', description: 'Anyone can open your profile', default: pr.profile !== 'private' },
        { label: 'Private', value: 'private', emoji: '🔒', description: 'Only you can see your profile', default: pr.profile === 'private' },
      ])
    );
    blocks.push(ui.text(ui.label('Hide from others')));
    blocks.push(
      ui.select(
        's:hide',
        'Hide from others (pick any)…',
        Object.entries(social.PRIVACY_PARTS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, default: pr.hide.includes(k) })),
        { min: 0, max: Object.keys(social.PRIVACY_PARTS).length }
      )
    );
    blocks.push(ui.text('-# Hidden parts still show for **you**. Leaderboards skip anything you hide.'));
  }

  if (cat === 'more') {
    const pf = d.data.prefs;
    blocks.push(ui.text(ui.label('Time zone')));
    blocks.push(
      ui.select(
        's:tz',
        'Time zone (for streaks & monthly stats)…',
        social.TIMEZONES.map(([v, l]) => ({ label: l, value: v, default: pf.timezone === v }))
      )
    );
    blocks.push(ui.text(ui.label('Monthly recap')));
    blocks.push(
      ui.select('s:recap', 'Monthly recap…', [
        { label: 'Don’t DM me', value: 'off', emoji: '🔕', description: 'Open it any time with /recap', default: !pf.recapDm },
        { label: 'DM me my recap on the 1st', value: 'dm', emoji: '🎁', description: 'Your month in anime, delivered', default: Boolean(pf.recapDm) },
      ])
    );
    blocks.push(ui.text(ui.label('Review spoilers')));
    blocks.push(
      ui.select('s:spoil', 'New reviews default to…', [
        { label: 'No spoilers', value: 'no', emoji: '✅', default: !pf.spoilerDefault },
        { label: 'Contains spoilers', value: 'yes', emoji: '⚠️', default: Boolean(pf.spoilerDefault) },
      ])
    );
  }

  if (cat === 'server') {
    const isManager = interaction?.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!interaction?.guildId || !isManager) {
      blocks.push(ui.text('-# Only people with **Manage Server** can change server settings.'));
    } else {
      const s = await ctx.loadSocial();
      const enabled = statsUi.guildBoards(s, interaction.guildId);
      blocks.push(ui.text('-# Server settings apply **immediately** (no Save needed). Turn off anything that feels too competitive.'));
      blocks.push(
        ui.select(
          's:lb',
          'Leaderboards shown in /leaderboard…',
          Object.entries(statsUi.BOARDS).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, default: enabled.includes(k) })),
          { min: 0, max: Object.keys(statsUi.BOARDS).length }
        )
      );
    }
  }
  return blocks;
}

async function previewCard(userId, d) {
  const u = await draftUser(userId, d);
  const pal = paletteFor(u.profile);
  let user = null;
  try {
    user = ctx.client.users.cache.get(userId) || (await ctx.client.users.fetch(userId));
  } catch {
    /* ignore */
  }
  const name = u.profile.displayName || user?.globalName || user?.username || 'You';
  const children = [ui.text('-# 👁️ LIVE PREVIEW')];
  const banner = bannerUrlFor(u.profile);
  const g = banner ? ui.gallery([{ url: banner, description: 'Banner preview' }]) : null;
  if (g) children.push(g);
  const lines = [`## ${ui.esc(name)}`, `-# ${user ? `@${user.username} · ` : ''}${pal.name} theme`];
  if (u.profile.tagline) lines.push(`*${ui.softEsc(u.profile.tagline)}*`);
  children.push(ui.row(lines, user?.displayAvatarURL?.({ size: 256, extension: 'png' })));
  if (u.profile.bio && u.profile.sections.includes('bio')) children.push(ui.text(ui.softEsc(ui.clip(u.profile.bio, 300))));
  const f = u.profile.featured;
  if (f && u.profile.sections.includes('featured')) children.push(ui.row([ui.label('Featured'), `**${ui.esc(f.title)}**`], f.cover));
  if (u.profile.opening && u.profile.sections.includes('opening')) children.push(ui.text(`-# 🎵 ${ui.esc(u.profile.opening.song || u.profile.opening.slug)} · ${ui.esc(u.profile.opening.animeTitle)}`));
  return ui.card(pal.accent, children);
}

async function render(userId, interaction, note) {
  const d = await getDraft(userId);
  const cat = CATEGORIES[d.cat] ? d.cat : 'look';
  if (!note && !d.dirty) {
    const s = await ctx.loadSocial();
    if (!social.isCustomized(social.peekUser(s, userId))) note = '👋 Welcome! Try things out — the preview updates live and nothing applies until you Save';
  }
  const status = d.dirty ? `${note ? `${note}  ·  ` : ''}● **Unsaved changes** — tap Save to apply` : note || '✓ Everything’s saved';
  const head = ui.text(`## ⚙️ Settings  ›  ${CATEGORIES[cat].emoji} ${CATEGORIES[cat].label}\n-# ${status}`);
  const catSelect = ui.select(
    's:cat',
    'Jump to…',
    Object.entries(CATEGORIES).map(([k, v]) => ({ label: v.label, value: k, emoji: v.emoji, description: v.description, default: k === cat }))
  );
  const footer = [
    ui.button('s:save', 'Save', { emoji: '💾', style: ui.ButtonStyle.Success, disabled: !d.dirty }),
    ui.button('s:discard', 'Discard', { emoji: '↩️', disabled: !d.dirty }),
    ui.button('s:preview', 'Full preview', { emoji: '👁️' }),
  ];
  if (cat === 'activity') footer.push(ui.button('s:postpreview', 'Preview a post', { emoji: '📡' }));
  const panel = ui.card(ui.ANILIST_BLUE, [head, catSelect, ui.divider(), ...(await panelBlocks(userId, d, interaction)), ui.divider(), ui.actionRow(footer)]);
  const cards = [panel];
  if (!['server', 'more', 'privacy', 'activity'].includes(cat)) cards.push(await previewCard(userId, d));
  return ui.fit(cards);
}

/* ------------------------------- persistence ------------------------------- */

async function save(userId, d) {
  const s = await ctx.loadSocial();
  const u = social.getUser(s, userId);
  for (const f of DRAFT_FIELDS) u[f] = clone(d.data[f]);
  u.profile.customizedAt = new Date().toISOString();
  if (d.autoPost !== undefined) {
    const core = await ctx.loadData();
    const linked = core.linkedAccounts[userId];
    if (linked && ctx.setLiveActivity) await ctx.setLiveActivity(core, linked, d.autoPost, userId);
    d.autoPost = undefined;
  }
  await ctx.saveSocial();
  d.dirty = false;
}

/* --------------------------------- modals --------------------------------- */

function textModal(p) {
  const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(false).setPlaceholder('Leave empty to use your Discord name');
  if (p.displayName) name.setValue(p.displayName);
  const tag = new TextInputBuilder().setCustomId('tagline').setStyle(TextInputStyle.Short).setMaxLength(social.LIMITS.tagline).setRequired(false).setPlaceholder('e.g. “currently losing to the backlog”');
  if (p.tagline) tag.setValue(p.tagline);
  const bio = new TextInputBuilder().setCustomId('bio').setStyle(TextInputStyle.Paragraph).setMaxLength(social.LIMITS.bio).setRequired(false).setPlaceholder('A few lines about you and what you love to watch');
  if (p.bio) bio.setValue(p.bio);
  return new ModalBuilder()
    .setCustomId('s:m:text')
    .setTitle('Your profile')
    .addLabelComponents(
      new LabelBuilder().setLabel('Display name').setDescription('Shown big at the top of your profile').setTextInputComponent(name),
      new LabelBuilder().setLabel('Tagline').setDescription('One short line under your name').setTextInputComponent(tag),
      new LabelBuilder().setLabel('Bio').setTextInputComponent(bio)
    );
}

function colorModal(p) {
  const pal = paletteFor(p);
  const mk = (id, cur, ph) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(false).setPlaceholder(ph);
    if (cur !== null && cur !== undefined) t.setValue(hex(cur));
    return t;
  };
  return new ModalBuilder()
    .setCustomId('s:m:color')
    .setTitle('Custom colours')
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Use hex codes like **#A855F7**. Leave a box empty to keep your theme’s colour.\nCurrent: accent ${hex(pal.accent)} · highlight ${hex(pal.accent2)} · background ${hex(pal.bg)}`))
    .addLabelComponents(
      new LabelBuilder().setLabel('Accent').setDescription('Card stripe + main banner colour').setTextInputComponent(mk('accent', p.accent, hex(pal.accent))),
      new LabelBuilder().setLabel('Highlight').setDescription('Glow + sparkles on your banner').setTextInputComponent(mk('accent2', p.accent2, hex(pal.accent2))),
      new LabelBuilder().setLabel('Background').setDescription('Banner base — try black for AMOLED, white for pastel').setTextInputComponent(mk('background', p.background, hex(pal.bg)))
    );
}

function bannerModal(p) {
  const t = new TextInputBuilder().setCustomId('url').setStyle(TextInputStyle.Short).setMaxLength(400).setRequired(true).setPlaceholder('https://…/my-banner.png');
  if (p.bannerUrl) t.setValue(p.bannerUrl);
  return new ModalBuilder()
    .setCustomId('s:m:bannerurl')
    .setTitle('Banner image')
    .addLabelComponents(new LabelBuilder().setLabel('Image link').setDescription('Wide images (about 4:1) look best').setTextInputComponent(t));
}

function featNoteModal(p) {
  const t = new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(social.LIMITS.note * 2).setRequired(false).setPlaceholder('Why this one? (shown under it on your profile)');
  if (p.featured?.note) t.setValue(p.featured.note);
  return new ModalBuilder()
    .setCustomId('s:m:featnote')
    .setTitle('Featured anime note')
    .addLabelComponents(new LabelBuilder().setLabel('Note').setDescription('Leave empty for no note').setTextInputComponent(t));
}

function openingManualModal(mediaId, animeTitle) {
  const song = new TextInputBuilder().setCustomId('song').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setPlaceholder('e.g. unravel');
  const artist = new TextInputBuilder().setCustomId('artist').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(false).setPlaceholder('e.g. TK from Ling tosite sigure');
  const slug = new StringSelectMenuBuilder()
    .setCustomId('slug')
    .setRequired(true)
    .addOptions(Array.from({ length: 10 }, (_, i) => ({ label: `Opening ${i + 1}`, value: `OP${i + 1}`, default: i === 0 })));
  return new ModalBuilder()
    .setCustomId(`s:m:opmanual:${mediaId}`)
    .setTitle(ui.clip(`Opening · ${animeTitle || 'anime'}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Song title').setTextInputComponent(song),
      new LabelBuilder().setLabel('Artist').setDescription('Optional').setTextInputComponent(artist),
      new LabelBuilder().setLabel('Which opening').setStringSelectMenuComponent(slug)
    );
}

/* -------------------------------- handlers -------------------------------- */

async function respondPanel(interaction, note) {
  const payload = await render(interaction.user.id, interaction, note);
  // Edit the private panel in place when we're already inside it; otherwise open a new private one.
  const inPrivateMessage = interaction.message?.flags?.has?.(ui.EPHEMERAL) && (interaction.isMessageComponent?.() || interaction.isModalSubmit?.());
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else if (inPrivateMessage) await interaction.update(payload);
    else await interaction.reply({ ...payload, flags: ui.V2 | ui.EPHEMERAL });
  } catch (e) {
    console.error('Settings render failed:', e.message);
  }
}

async function handleCommand(interaction) {
  const d = await getDraft(interaction.user.id);
  const cat = interaction.options?.getString?.('section');
  if (cat && CATEGORIES[cat]) d.cat = cat;
  return respondPanel(interaction);
}

async function onComponent(interaction) {
  const id = interaction.customId;
  const me = interaction.user.id;
  if (id.startsWith('s:open')) {
    const d = await getDraft(me);
    return respondPanel(interaction, d.dirty ? 'Picked up where you left off' : null);
  }
  const d = await getDraft(me);
  const p = d.data.profile;
  const v = interaction.values || [];
  const key = id.split(':')[1];

  switch (key) {
    case 'cat':
      d.cat = v[0];
      break;
    case 'theme':
      if (v[0] === '_custom') return interaction.showModal(colorModal(p));
      p.theme = v[0];
      p.accent = null;
      p.accent2 = null;
      p.background = null;
      changed(d);
      break;
    case 'banner':
      p.bannerMode = v[0];
      changed(d);
      if (v[0] === 'url' && !p.bannerUrl) return interaction.showModal(bannerModal(p));
      break;
    case 'sections':
      p.sections = v.filter((x) => social.SECTIONS[x]);
      changed(d);
      break;
    case 'layout':
      p.layout = v[0];
      changed(d);
      break;
    case 'feat': {
      if (v[0] === '_search') return picker.openSearch(interaction, 'feat', '-', { title: 'Feature an anime' });
      if (v[0] === '_none') p.featured = null;
      else {
        const s = await ctx.loadSocial();
        const fav = social.peekUser(s, me).favorites.find((e) => e.mediaId === parseInt(v[0], 10));
        if (fav) p.featured = { ...fav, note: p.featured?.mediaId === fav.mediaId ? p.featured.note : fav.note };
        if (!p.sections.includes('featured')) p.sections.push('featured');
      }
      changed(d);
      break;
    }
    case 'pickop':
      return picker.openSearch(interaction, 'op', '-', { title: 'Favorite opening — which anime?' });
    case 'op': {
      // s:op:<mediaId> — chose an opening from the AnimeThemes list
      const mediaId = parseInt(id.split(':')[2], 10);
      if (v[0] === '_manual') {
        const anime = d.pendingOpening?.animeTitle;
        return interaction.showModal(openingManualModal(mediaId, anime));
      }
      const op = (d.pendingOpening?.list || []).find((o) => o.slug === v[0]);
      if (op) {
        p.opening = { mediaId, animeTitle: d.pendingOpening.animeTitle, cover: d.pendingOpening.cover, ...op };
        if (!p.sections.includes('opening')) p.sections.push('opening');
        changed(d);
      }
      d.pendingOpening = null;
      d.cat = 'profile';
      break;
    }
    case 'style':
      d.data.activity.style = v[0];
      changed(d);
      break;
    case 'color':
      d.data.activity.color = v[0];
      changed(d);
      break;
    case 'show':
      d.data.activity.show = v.filter((x) => social.ACTIVITY_FIELDS[x]);
      changed(d);
      break;
    case 'auto': {
      const core = await ctx.loadData();
      const linked = core.linkedAccounts[me];
      if (linked) {
        const current = d.autoPost !== undefined ? d.autoPost : !core.trackingOptOut[String(linked.anilistId)];
        d.autoPost = !current;
        changed(d);
      }
      break;
    }
    case 'vis':
      d.data.privacy.profile = v[0];
      changed(d);
      break;
    case 'hide':
      d.data.privacy.hide = v.filter((x) => social.PRIVACY_PARTS[x]);
      changed(d);
      break;
    case 'tz':
      d.data.prefs.timezone = v[0];
      changed(d);
      break;
    case 'recap':
      d.data.prefs.recapDm = v[0] === 'dm';
      changed(d);
      break;
    case 'spoil':
      d.data.prefs.spoilerDefault = v[0] === 'yes';
      changed(d);
      break;
    case 'lb': {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) break;
      const s = await ctx.loadSocial();
      const cfg = (s.guildConfig[interaction.guildId] ||= {});
      cfg.leaderboards = Object.fromEntries(Object.keys(statsUi.BOARDS).map((k) => [k, v.includes(k)]));
      await ctx.saveSocial();
      return respondPanel(interaction, '✅ Server leaderboards updated');
    }
    case 'edit': {
      const what = id.split(':')[2];
      if (what === 'text') return interaction.showModal(textModal(p));
      if (what === 'color') return interaction.showModal(colorModal(p));
      if (what === 'bannerurl') return interaction.showModal(bannerModal(p));
      if (what === 'featnote') {
        if (!p.featured) return respondPanel(interaction, 'Pick a featured anime first');
        return interaction.showModal(featNoteModal(p));
      }
      break;
    }
    case 'save':
      await interaction.deferUpdate().catch(() => {}); // turning auto-post back on asks AniList
      await save(me, d);
      return respondPanel(interaction, '💾 Saved!');
    case 'discard':
      drafts.delete(me);
      {
        const fresh = await getDraft(me);
        fresh.cat = d.cat;
      }
      return respondPanel(interaction, '↩️ Changes discarded');
    case 'preview': {
      const { renderProfile } = require('./profile');
      const u = await draftUser(me, d);
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      const payload = await renderProfile({
        ownerId: me,
        viewerId: me,
        userOverride: u,
        notice: `-# 👁️ PREVIEW${d.dirty ? ' — includes unsaved changes. Save in the settings panel to apply them.' : ''}`,
      });
      return interaction.editReply(payload).catch((e) => console.error('Preview failed:', e.message));
    }
    case 'postpreview': {
      await interaction.deferReply({ flags: ui.EPHEMERAL }).catch(() => {});
      const u = await draftUser(me, d);
      const embed = ctx.buildActivityPreview ? await ctx.buildActivityPreview(me, u) : null;
      return interaction
        .editReply(embed ? { content: '-# 📡 This is how your next activity post will look' + (d.dirty ? ' (unsaved changes included)' : ''), ...embed } : { content: 'Preview unavailable right now.' })
        .catch((e) => console.error('Post preview failed:', e.message));
    }
    default:
      return;
  }
  return respondPanel(interaction);
}

async function onModal(interaction) {
  const parts = interaction.customId.split(':');
  const what = parts[2];
  const me = interaction.user.id;
  const d = await getDraft(me);
  const p = d.data.profile;
  let note = null;

  if (what === 'text') {
    p.displayName = interaction.fields.getTextInputValue('name').trim() || null;
    p.tagline = interaction.fields.getTextInputValue('tagline').trim() || null;
    p.bio = interaction.fields.getTextInputValue('bio').trim() || null;
    if (p.bio && !p.sections.includes('bio')) p.sections.unshift('bio');
    changed(d);
  }
  if (what === 'color') {
    const bad = [];
    for (const k of ['accent', 'accent2', 'background']) {
      const raw = interaction.fields.getTextInputValue(k).trim();
      if (!raw) {
        p[k] = null;
        continue;
      }
      const n = parseHex(raw);
      if (n === null) bad.push(raw);
      else p[k] = n;
    }
    if (bad.length) note = `⚠️ Couldn’t read ${bad.map((b) => `“${ui.esc(b)}”`).join(', ')} — use hex like #A855F7`;
    changed(d);
    d.cat = 'look';
  }
  if (what === 'bannerurl') {
    const url = interaction.fields.getTextInputValue('url').trim();
    if (/^https:\/\/\S+$/i.test(url)) {
      p.bannerUrl = url;
      p.bannerMode = 'url';
    } else note = '⚠️ That link needs to start with https://';
    changed(d);
  }
  if (what === 'featnote' && p.featured) {
    p.featured.note = interaction.fields.getTextInputValue('note').trim() || null;
    changed(d);
  }
  if (what === 'opmanual') {
    const mediaId = parseInt(parts[3], 10);
    let slug = 'OP1';
    try {
      slug = interaction.fields.getStringSelectValues('slug')?.[0] || 'OP1';
    } catch {
      /* default */
    }
    p.opening = {
      mediaId,
      animeTitle: d.pendingOpening?.animeTitle || 'Anime',
      cover: d.pendingOpening?.cover || null,
      slug,
      song: interaction.fields.getTextInputValue('song').trim(),
      artists: [interaction.fields.getTextInputValue('artist').trim()].filter(Boolean),
      videoUrl: null,
      pageUrl: null,
    };
    if (!p.sections.includes('opening')) p.sections.push('opening');
    d.pendingOpening = null;
    d.cat = 'profile';
    changed(d);
  }
  return respondPanel(interaction, note);
}

/* --------------------------- picker purposes --------------------------- */

picker.registerPurpose('feat', {
  title: 'Feature an anime',
  async onPick(interaction, media) {
    const d = await getDraft(interaction.user.id);
    d.data.profile.featured = { ...snapshot(media), note: null };
    if (!d.data.profile.sections.includes('featured')) d.data.profile.sections.push('featured');
    d.cat = 'profile';
    changed(d);
    return respondPanel(interaction);
  },
  async onCancel(interaction) {
    return respondPanel(interaction);
  },
});

picker.registerPurpose('op', {
  title: 'Favorite opening — which anime?',
  async onPick(interaction, media) {
    const d = await getDraft(interaction.user.id);
    let list = [];
    try {
      list = await getOpenings(media.id);
    } catch (e) {
      console.error('AnimeThemes lookup failed:', e.message);
    }
    d.pendingOpening = { mediaId: media.id, animeTitle: titleOf(media), cover: media.coverImage?.large || null, list };
    const options = [
      ...list.slice(0, 24).map((o) => ({
        label: ui.clip(`${o.slug} · ${o.song}`, 100),
        value: o.slug,
        emoji: '🎵',
        description: ui.clip([o.artists.join(', '), o.episodes ? `eps ${o.episodes}` : null].filter(Boolean).join(' · ') || 'AnimeThemes', 100),
      })),
      { label: 'Not listed — type it in', value: '_manual', emoji: '⌨️' },
    ];
    const children = [
      ui.row([`### 🎵 Openings · ${ui.esc(titleOf(media))}`, list.length ? `-# ${list.length} opening${list.length === 1 ? '' : 's'} found on AnimeThemes — pick your favorite` : '-# No openings found on AnimeThemes — type it in instead'], media.coverImage?.large),
      ui.select(`s:op:${media.id}`, 'Pick the opening…', options),
      ui.actionRow(ui.button('s:open:back', 'Back to settings', { emoji: '↩️' })),
    ];
    const payload = ui.fit([ui.card(ui.ANILIST_BLUE, children)]);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.update(payload);
    } catch (e) {
      console.error('Opening list failed:', e.message);
    }
  },
  async onCancel(interaction) {
    return respondPanel(interaction);
  },
});

module.exports = { handleCommand, onComponent, onModal, render, CATEGORIES, getDraft };
