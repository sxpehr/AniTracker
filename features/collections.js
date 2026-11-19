const { ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, StringSelectMenuBuilder } = require('discord.js');
const ui = require('./ui');
const social = require('./social');
const { paletteFor } = require('./themes');
const { ctx } = require('./ctx');
const { snapshot, getProfileSnapshot, titleOf, getMediaLite } = require('./anilistSocial');
const picker = require('./picker');

/* ---------------------------------------------------------------------------
 * Collections: Favorites, Watch Later, Recommendations, In Rotation and
 * custom lists ("Comfort Anime", "Best Villains"…).
 *
 * Viewing uses the owner's theme colour. Managing (reorder, notes, remove,
 * create) is a "menu", so it uses the AniList-blue system style.
 *
 * ids:
 *   c:v:<owner>:<key>:<manage>:<page>    view / page
 *   c:sel:<key>:<page>                   pick an item to edit (owner)
 *   c:i:<key>:<mediaId>                  item editor (owner)
 *   c:mv:<key>:<mediaId>:<dir>           move
 *   c:rm:<key>:<mediaId>                 remove
 *   c:note:<key>:<mediaId>               note form
 *   c:start:<mediaId>                    watch later → started (rotation)
 *   c:feat:<mediaId>                     feature on profile
 *   c:add:<key>                          add anime (search)
 *   c:new                                create collection form
 *   c:edit:<key> / c:del:<key> / c:delok:<key>
 *   c:addto:<mediaId>                    multi-select "save to lists" (from activity posts)
 *   c:rot:pin / c:rot:hide / c:rot:add / c:rot:rm
 * ------------------------------------------------------------------------- */

const PAGE = 10;

function listMeta(u, key) {
  if (key === 'rotation') return { name: 'In Rotation', emoji: '🔄', description: 'Currently watching — progress synced from AniList' };
  const r = social.getList(u, key);
  if (!r) return null;
  return { name: r.meta.name, emoji: r.meta.emoji || '🗂️', description: r.meta.description || '', visibility: r.meta.visibility };
}

function privacyPartFor(key) {
  if (key === 'watchlist') return 'watchlist';
  if (key === 'recommendations') return 'recommendations';
  return 'collections';
}

function itemLine(e, i) {
  const n = String(i + 1).padStart(2, '0');
  const title = `**[${ui.esc(ui.clip(e.title, 70))}](${e.siteUrl})**`;
  const extra = e.message ? ` — “${ui.softEsc(ui.clip(e.message, 90))}”` : e.note ? ` — *${ui.softEsc(ui.clip(e.note, 90))}*` : '';
  const started = e.startedAt ? ' · ▶️ started' : '';
  return `\`${n}\` ${title}${extra}${started}`;
}

function pagerRow(prefix, page, pages) {
  if (pages <= 1) return null;
  return ui.actionRow(
    ui.button(`${prefix}:${Math.max(0, page - 1)}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
    ui.button(`${prefix}:noop`, `${page + 1} / ${pages}`, { disabled: true }),
    ui.button(`${prefix}:${Math.min(pages - 1, page + 1)}`, 'Next', { emoji: '▶️', disabled: page >= pages - 1 })
  );
}

/* --------------------------------- views --------------------------------- */

// Blocks for one collection page (used standalone and inside the profile).
function collectionBlocks(u, key, { ownerId, page = 0, manage = false, pagerPrefix }) {
  const meta = listMeta(u, key);
  if (!meta) return [ui.text('That collection no longer exists.')];
  const { list } = social.getList(u, key);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);

  const vis = meta.visibility === 'private' ? '  ·  🔒 private' : '';
  const blocks = [ui.text(`### ${meta.emoji} ${ui.esc(meta.name)}  ·  ${list.length}${vis}\n-# ${ui.esc(meta.description || ' ')}`)];
  if (!list.length) {
    blocks.push(ui.text(manage ? '*Empty for now — tap **Add anime** below to start.*' : '*Nothing here yet.*'));
  } else {
    const g = ui.coverGallery(slice.map((e) => ({ url: e.cover, description: e.title })));
    if (g) blocks.push(g);
    blocks.push(ui.text(slice.map((e, i) => itemLine(e, page * PAGE + i)).join('\n')));
  }
  const pr = pagerRow(pagerPrefix || `c:v:${ownerId}:${key}:${manage ? 1 : 0}`, page, pages);
  if (pr) blocks.push(pr);

  if (manage) {
    if (slice.length) {
      blocks.push(
        ui.select(
          `c:sel:${key}:${page}`,
          'Edit a title — move, add a note, remove…',
          slice.map((e, i) => ({ label: ui.clip(`${page * PAGE + i + 1}. ${e.title}`, 100), value: String(e.mediaId), description: e.note ? ui.clip(e.note, 100) : undefined }))
        )
      );
    }
    const controls = [ui.button(`c:add:${key}`, 'Add anime', { emoji: '➕', style: ui.ButtonStyle.Primary })];
    if (!['favorites', 'watchlist', 'recommendations'].includes(key)) {
      controls.push(ui.button(`c:edit:${key}`, 'Edit details', { emoji: '✏️' }), ui.button(`c:del:${key}`, 'Delete', { emoji: '🗑️', style: ui.ButtonStyle.Danger }));
    }
    controls.push(ui.button('c:home', 'All lists', { emoji: '🗂️' }));
    blocks.push(ui.actionRow(controls));
  }
  return blocks;
}

async function rotationEntries(u, anilistId) {
  let current = [];
  if (anilistId) {
    try {
      current = (await getProfileSnapshot(anilistId))?.current || [];
    } catch (e) {
      console.error('Rotation lookup failed:', e.message);
    }
  }
  const pinned = u.rotation.pinned || [];
  const hidden = new Set(u.rotation.hidden || []);
  const fromAni = current
    .filter((e) => !hidden.has(e.media.id))
    .map((e) => ({
      ...snapshot(e.media),
      progress: e.progress || 0,
      total: e.media.episodes || null,
      next: e.media.nextAiringEpisode || null,
      pinned: pinned.includes(e.media.id),
      updatedAt: e.updatedAt,
    }));
  const extra = (u.rotation.extra || [])
    .filter((x) => !fromAni.some((a) => a.mediaId === x.mediaId) && !hidden.has(x.mediaId))
    .map((x) => ({ ...x, progress: null, total: x.episodes || null, pinned: pinned.includes(x.mediaId), manual: true }));
  const all = [...fromAni, ...extra];
  all.sort((a, b) => (b.pinned - a.pinned) || (pinned.indexOf(a.mediaId) - pinned.indexOf(b.mediaId)) || 0);
  return { all, current };
}

function rotationLine(e) {
  const title = `**[${ui.esc(ui.clip(e.title, 48))}](${e.siteUrl})**`;
  const pin = e.pinned ? '📌 ' : '';
  if (e.progress === null) return `${pin}${title}\n-# added by hand`;
  if (e.total) return `${pin}${title}\n${ui.bar(e.progress, e.total, 12)}  \`${e.progress}/${e.total}\``;
  const next = e.next ? ` · ep ${e.next.episode} ${ui.relTime(e.next.airingAt * 1000)}` : '';
  return `${pin}${title}\n-# on episode ${e.progress}${next}`;
}

async function rotationBlocks(u, anilistId, { manage = false, limit = 8 } = {}) {
  const { all, current } = await rotationEntries(u, anilistId);
  const blocks = [ui.text(`### 🔄 In Rotation  ·  ${all.length}\n-# What’s being watched right now — progress syncs from AniList`)];
  if (!anilistId && !all.length) blocks.push(ui.text('*Link an AniList account with `/signin` to fill this automatically.*'));
  else if (!all.length) blocks.push(ui.text('*Nothing in rotation right now.*'));
  else {
    const top = all.slice(0, limit);
    const g = ui.coverGallery(top.slice(0, 4).map((e) => ({ url: e.cover, description: e.title })));
    if (g) blocks.push(g);
    blocks.push(ui.text(top.map(rotationLine).join('\n')));
  }
  if (manage) {
    const options = all.slice(0, 25).map((e) => ({ label: ui.clip(e.title, 100), value: String(e.mediaId), default: e.pinned }));
    if (options.length) blocks.push(ui.select('c:rot:pin', '📌 Pin shows to the top (pick any)', options, { min: 0, max: options.length }));
    const hideOpts = [...current.map((e) => e.media), ...(u.rotation.extra || []).map((x) => ({ id: x.mediaId, title: { english: x.title } }))]
      .slice(0, 25)
      .map((m) => ({ label: ui.clip(titleOf(m), 100), value: String(m.id), default: (u.rotation.hidden || []).includes(m.id) }));
    if (hideOpts.length) blocks.push(ui.select('c:rot:hide', '🙈 Hide shows from your profile (pick any)', hideOpts, { min: 0, max: hideOpts.length }));
    blocks.push(ui.actionRow(ui.button('c:rot:add', 'Add a show by hand', { emoji: '➕', style: ui.ButtonStyle.Primary }), ui.button('c:home', 'All lists', { emoji: '🗂️' })));
  }
  return blocks;
}

// "All lists" home: every collection with a count and a peek at covers.
function homeBlocks(u, { ownerId, viewerId, manage }) {
  const own = viewerId === ownerId;
  const lists = [
    ['favorites', social.BUILTIN.favorites, u.favorites],
    ['watchlist', social.BUILTIN.watchlist, u.watchlist],
    ['recommendations', social.BUILTIN.recommendations, u.recommendations],
    ...u.collections.map((c) => [c.id, c, c.items]),
  ].filter(([key, meta]) => own || (social.canView(u, viewerId, ownerId, privacyPartFor(key)) && meta.visibility !== 'private'));

  const blocks = [ui.text(`### 🗂️ ${manage ? 'Your lists' : 'Collections'}\n-# ${manage ? 'Open a list to reorder, add notes or remove titles' : 'Pick a list to open it'}`)];
  const lines = lists.map(([key, meta, items]) => {
    const peek = items
      .slice(0, 3)
      .map((e) => ui.esc(ui.clip(e.title, 28)))
      .join(' · ');
    const lock = meta.visibility === 'private' ? ' 🔒' : '';
    return `${meta.emoji || '🗂️'} **${ui.esc(meta.name)}**${lock}  \`${items.length}\`${peek ? `\n-# ${peek}` : ''}`;
  });
  lines.push(`🔄 **In Rotation**\n-# synced from AniList`);
  blocks.push(ui.text(lines.join('\n')));
  const options = [
    ...lists.map(([key, meta, items]) => ({ label: `${meta.name} (${items.length})`, value: key, emoji: meta.emoji || '🗂️', description: ui.clip(meta.description || '', 100) || undefined })),
    { label: 'In Rotation', value: 'rotation', emoji: '🔄', description: 'Currently watching' },
  ];
  blocks.push(ui.select(`c:open:${ownerId}:${manage ? 1 : 0}`, 'Open a list…', options));
  if (manage) blocks.push(ui.actionRow(ui.button('c:new', 'New collection', { emoji: '✨', style: ui.ButtonStyle.Primary })));
  return blocks;
}

async function viewPayload({ ownerId, viewerId, key, page = 0, manage = false }) {
  const s = await ctx.loadSocial();
  const core = await ctx.loadData();
  const u = social.peekUser(s, ownerId);
  const pal = paletteFor(u.profile);
  const accent = manage ? ui.ANILIST_BLUE : pal.accent;
  const own = viewerId === ownerId;

  if (key && key !== 'home' && key !== 'rotation') {
    const meta = social.getList(u, key)?.meta;
    if (!own && (!social.canView(u, viewerId, ownerId, privacyPartFor(key)) || meta?.visibility === 'private')) {
      return ui.fit([ui.card(accent, [ui.text('### 🔒 Private\nThis list is private.')])]);
    }
  }

  let blocks;
  if (!key || key === 'home') blocks = homeBlocks(u, { ownerId, viewerId, manage: manage && own });
  else if (key === 'rotation') blocks = await rotationBlocks(u, social.anilistFor(core, ownerId)?.id, { manage: manage && own });
  else blocks = collectionBlocks(u, key, { ownerId, page, manage: manage && own });

  if (!manage && key && key !== 'home') blocks.push(ui.actionRow(ui.button(`c:v:${ownerId}:home:0:0`, 'All lists', { emoji: '🗂️' })));
  return ui.fit([ui.card(accent, blocks)]);
}

function itemEditor(u, key, mediaId) {
  const r = social.getList(u, key);
  const list = r?.list || [];
  const idx = list.findIndex((e) => e.mediaId === mediaId);
  if (idx === -1) return ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text('That title isn’t in this list anymore.'), ui.actionRow(ui.button(`c:v:me:${key}:1:0`, 'Back', { emoji: '↩️' }))])]);
  const e = list[idx];
  const meta = listMeta(u, key);
  const blocks = [
    ui.text(`-# ${meta.emoji} ${ui.esc(meta.name).toUpperCase()}  ›  EDIT`),
    ui.row(
      [
        `### [${ui.esc(e.title)}](${e.siteUrl})`,
        `-# #${idx + 1} of ${list.length}${e.addedAt ? ` · added ${ui.relTime(e.addedAt)}` : ''}`,
        e.note || e.message ? `> ${ui.softEsc(e.note || e.message)}` : '-# No note yet — add one to say why it’s here.',
      ],
      e.cover
    ),
    ui.divider(),
    ui.actionRow(
      ui.button(`c:mv:${key}:${mediaId}:top`, 'Top', { emoji: '⏫', disabled: idx === 0 }),
      ui.button(`c:mv:${key}:${mediaId}:up`, 'Up', { emoji: '🔼', disabled: idx === 0 }),
      ui.button(`c:mv:${key}:${mediaId}:down`, 'Down', { emoji: '🔽', disabled: idx === list.length - 1 }),
      ui.button(`c:note:${key}:${mediaId}`, key === 'recommendations' ? 'Message' : 'Note', { emoji: '✏️' }),
      ui.button(`c:rm:${key}:${mediaId}`, 'Remove', { emoji: '🗑️', style: ui.ButtonStyle.Danger })
    ),
  ];
  const extras = [];
  if (key === 'watchlist') extras.push(ui.button(`c:start:${mediaId}`, e.startedAt ? 'Started ✓' : 'Mark as started', { emoji: '▶️', style: ui.ButtonStyle.Success, disabled: Boolean(e.startedAt) }));
  if (key === 'favorites') extras.push(ui.button(`c:feat:${mediaId}`, u.profile.featured?.mediaId === mediaId ? 'Featured ✓' : 'Feature on profile', { emoji: '🎞️', style: ui.ButtonStyle.Success, disabled: u.profile.featured?.mediaId === mediaId }));
  extras.push(ui.button(`c:v:me:${key}:1:${Math.floor(idx / PAGE)}`, 'Back to list', { emoji: '↩️' }));
  blocks.push(ui.actionRow(extras));
  return ui.fit([ui.card(ui.ANILIST_BLUE, blocks)]);
}

/* ------------------------------ save-to menu ------------------------------ */

function saveToPayload(u, media) {
  const snap = snapshot(media);
  const lists = [
    ['favorites', social.BUILTIN.favorites, u.favorites],
    ['watchlist', social.BUILTIN.watchlist, u.watchlist],
    ['recommendations', social.BUILTIN.recommendations, u.recommendations],
    ...u.collections.map((c) => [c.id, c, c.items]),
  ];
  const blocks = [
    ui.row([`-# SAVE TO YOUR LISTS`, `### ${ui.esc(snap.title)}`, '-# Tick every list it belongs in — untick to remove'], snap.cover),
    ui.select(
      `c:addto:${snap.mediaId}`,
      'Choose lists…',
      lists.map(([key, meta, items]) => ({ label: meta.name, value: key, emoji: meta.emoji || '🗂️', default: items.some((e) => e.mediaId === snap.mediaId) })),
      { min: 0, max: lists.length }
    ),
    ui.actionRow(ui.button('c:new', 'New collection', { emoji: '✨' }), ui.button('c:mine', 'Manage my lists', { emoji: '🗂️' })),
  ];
  return ui.fit([ui.card(ui.ANILIST_BLUE, blocks)]);
}

/* --------------------------------- forms --------------------------------- */

function collectionModal(customId, title, existing = {}) {
  const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setPlaceholder('Comfort Anime');
  if (existing.name) name.setValue(existing.name);
  const desc = new TextInputBuilder().setCustomId('desc').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false).setPlaceholder('Shows I rewatch when I need a hug');
  if (existing.description) desc.setValue(existing.description);
  const emoji = new TextInputBuilder().setCustomId('emoji').setStyle(TextInputStyle.Short).setMaxLength(8).setRequired(false).setPlaceholder('🍵');
  if (existing.emoji) emoji.setValue(existing.emoji);
  const vis = new StringSelectMenuBuilder()
    .setCustomId('vis')
    .setRequired(true)
    .addOptions(
      { label: 'Public — anyone can see it on my profile', value: 'public', emoji: '🌍', default: existing.visibility !== 'private' },
      { label: 'Private — only I can see it', value: 'private', emoji: '🔒', default: existing.visibility === 'private' }
    );
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder().setLabel('Name').setTextInputComponent(name),
      new LabelBuilder().setLabel('Description').setDescription('Optional').setTextInputComponent(desc),
      new LabelBuilder().setLabel('Emoji').setDescription('Optional — one emoji for the list').setTextInputComponent(emoji),
      new LabelBuilder().setLabel('Who can see it').setStringSelectMenuComponent(vis)
    );
}

function noteModal(key, mediaId, existing) {
  const isRec = key === 'recommendations';
  const input = new TextInputBuilder()
    .setCustomId('note')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(social.LIMITS.note)
    .setRequired(false)
    .setPlaceholder(isRec ? 'Why should people watch it? (no spoilers!)' : 'Why it’s on this list…');
  if (existing) input.setValue(existing);
  return new ModalBuilder()
    .setCustomId(`c:m:note:${key}:${mediaId}`)
    .setTitle(isRec ? 'Recommendation message' : 'Add a note')
    .addLabelComponents(new LabelBuilder().setLabel(isRec ? 'Message' : 'Note').setDescription('Leave empty to remove it').setTextInputComponent(input));
}

/* -------------------------------- handlers -------------------------------- */

const firstEmoji = (s) => {
  const m = String(s || '').match(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/u);
  return m ? m[0] : null;
};

async function update(interaction, payload) {
  try {
    const privateMsg = interaction.message?.flags?.has?.(ui.EPHEMERAL);
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else if (interaction.message && privateMsg) await interaction.update(payload);
    else await interaction.reply({ ...payload, flags: ui.V2 | ui.EPHEMERAL }); // from a public card: open privately
  } catch (e) {
    console.error('Collections view update failed:', e.message);
  }
}

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const me = interaction.user.id;
  const s = await ctx.loadSocial();
  // Views that ask AniList (In Rotation, saving a title) get acknowledged first.
  const slow =
    action === 'addto' ||
    action === 'rot' && parts[2] !== 'add' ||
    (action === 'open' && interaction.values?.[0] === 'rotation') ||
    (action === 'v' && parts[3] === 'rotation');
  if (slow && interaction.message?.flags?.has?.(ui.EPHEMERAL)) await interaction.deferUpdate().catch(() => {});

  if (action === 'v') {
    // c:v:<owner>:<key>:<manage>:<page>
    let [, , owner, key, manage, page] = parts;
    if (page === 'noop') return interaction.deferUpdate().catch(() => {});
    if (owner === 'me') owner = me;
    const isManage = manage === '1' && owner === me;
    return update(interaction, await viewPayload({ ownerId: owner, viewerId: me, key, page: parseInt(page, 10) || 0, manage: isManage }));
  }

  if (action === 'open') {
    const [, , owner, manage] = parts;
    const key = interaction.values[0];
    return update(interaction, await viewPayload({ ownerId: owner, viewerId: me, key, page: 0, manage: manage === '1' && owner === me }));
  }

  if (action === 'home' || action === 'mine') {
    return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key: 'home', manage: true }));
  }

  const u = social.getUser(s, me);

  if (action === 'sel') {
    const [, , key] = parts;
    return update(interaction, itemEditor(u, key, parseInt(interaction.values[0], 10)));
  }
  if (action === 'i') return update(interaction, itemEditor(u, parts[2], parseInt(parts[3], 10)));

  if (action === 'mv') {
    const [, , key, mid, dir] = parts;
    const r = social.getList(u, key);
    if (r) social.moveItem(r.list, parseInt(mid, 10), dir);
    await ctx.saveSocial();
    return update(interaction, itemEditor(u, key, parseInt(mid, 10)));
  }

  if (action === 'rm') {
    const [, , key, mid] = parts;
    const r = social.getList(u, key);
    if (r) social.removeItem(r.list, parseInt(mid, 10));
    await ctx.saveSocial();
    return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key, page: 0, manage: true }));
  }

  if (action === 'note') {
    const [, , key, mid] = parts;
    const item = social.getList(u, key)?.list.find((e) => e.mediaId === parseInt(mid, 10));
    return interaction.showModal(noteModal(key, mid, key === 'recommendations' ? item?.message : item?.note));
  }

  if (action === 'start') {
    const mid = parseInt(parts[2], 10);
    const item = u.watchlist.find((e) => e.mediaId === mid);
    if (item) {
      item.startedAt = new Date().toISOString();
      if (!u.rotation.extra.some((x) => x.mediaId === mid)) u.rotation.extra.push({ ...item, startedAt: undefined, note: undefined });
    }
    await ctx.saveSocial();
    return update(interaction, itemEditor(u, 'watchlist', mid));
  }

  if (action === 'feat') {
    const mid = parseInt(parts[2], 10);
    const item = u.favorites.find((e) => e.mediaId === mid);
    if (item) {
      u.profile.featured = { ...item };
      if (!u.profile.sections.includes('featured')) u.profile.sections.push('featured');
    }
    await ctx.saveSocial();
    return update(interaction, itemEditor(u, 'favorites', mid));
  }

  if (action === 'add') return picker.openSearch(interaction, 'coll', parts[2], { title: 'Add to list' });
  if (action === 'new') return interaction.showModal(collectionModal('c:m:new', 'New collection'));
  if (action === 'edit') {
    const c = u.collections.find((x) => x.id === parts[2]);
    if (!c) return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key: 'home', manage: true }));
    return interaction.showModal(collectionModal(`c:m:edit:${c.id}`, 'Edit collection', c));
  }
  if (action === 'del') {
    const c = u.collections.find((x) => x.id === parts[2]);
    if (!c) return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key: 'home', manage: true }));
    return update(
      interaction,
      ui.fit([
        ui.card(ui.ANILIST_BLUE, [
          ui.text(`### 🗑️ Delete “${ui.esc(c.name)}”?\nIts ${c.items.length} title${c.items.length === 1 ? '' : 's'} will be removed from the list. This can’t be undone.`),
          ui.actionRow(ui.button(`c:delok:${c.id}`, 'Delete it', { style: ui.ButtonStyle.Danger, emoji: '🗑️' }), ui.button(`c:v:me:${c.id}:1:0`, 'Keep it', { emoji: '↩️' })),
        ]),
      ])
    );
  }
  if (action === 'delok') {
    u.collections = u.collections.filter((x) => x.id !== parts[2]);
    await ctx.saveSocial();
    return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key: 'home', manage: true }));
  }

  if (action === 'addto') {
    const mid = parseInt(parts[2], 10);
    const media = await getMediaLite(mid).catch(() => null);
    if (!media) return update(interaction, ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text('⚠️ AniList isn’t responding right now — try again in a moment.')])]));
    const snap = snapshot(media);
    const chosen = new Set(interaction.values);
    const keys = ['favorites', 'watchlist', 'recommendations', ...u.collections.map((c) => c.id)];
    const added = [];
    const removed = [];
    const full = [];
    for (const key of keys) {
      const r = social.getList(u, key);
      const has = r.list.some((e) => e.mediaId === mid);
      if (chosen.has(key) && !has) {
        const res = social.addItem(r.list, snap, key);
        if (res.ok) added.push(r.meta.name);
        else if (res.reason === 'full') full.push(r.meta.name);
      } else if (!chosen.has(key) && has) {
        social.removeItem(r.list, mid);
        removed.push(r.meta.name);
      }
    }
    social.markGuild(u, interaction.guildId);
    await ctx.saveSocial();
    const payload = saveToPayload(u, media);
    const summary = [
      added.length ? `✅ Added to **${added.join('**, **')}**` : null,
      removed.length ? `➖ Removed from **${removed.join('**, **')}**` : null,
      full.length ? `⚠️ **${full.join('**, **')}** is full` : null,
    ].filter(Boolean);
    if (summary.length) {
      const c = payload.components[0];
      c.addTextDisplayComponents(ui.text(`-# ${summary.join('  ·  ')}`));
    }
    return update(interaction, payload);
  }

  if (action === 'rot') {
    const sub = parts[2];
    if (sub === 'pin') u.rotation.pinned = interaction.values.map(Number);
    if (sub === 'hide') u.rotation.hidden = interaction.values.map(Number);
    if (sub === 'add') return picker.openSearch(interaction, 'rot', '-', { title: 'Add to In Rotation' });
    await ctx.saveSocial();
    return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key: 'rotation', manage: true }));
  }
}

async function onModal(interaction) {
  const parts = interaction.customId.split(':');
  const kind = parts[2];
  const me = interaction.user.id;
  const s = await ctx.loadSocial();
  const u = social.getUser(s, me);

  if (kind === 'new' || kind === 'edit') {
    const name = interaction.fields.getTextInputValue('name').trim();
    const description = (interaction.fields.getTextInputValue('desc') || '').trim();
    const emoji = firstEmoji(interaction.fields.getTextInputValue('emoji')) || '🗂️';
    let visibility = 'public';
    try {
      visibility = interaction.fields.getStringSelectValues('vis')?.[0] || 'public';
    } catch {
      /* default */
    }
    let key;
    if (kind === 'new') {
      if (u.collections.length >= social.LIMITS.collections) {
        return update(interaction, ui.fit([ui.card(ui.ANILIST_BLUE, [ui.text(`You can have up to ${social.LIMITS.collections} custom collections.`)])]));
      }
      key = social.newId('col_');
      u.collections.push({ id: key, name, description, emoji, visibility, items: [], createdAt: new Date().toISOString() });
    } else {
      key = parts[3];
      const c = u.collections.find((x) => x.id === key);
      if (c) Object.assign(c, { name, description, emoji, visibility });
    }
    await ctx.saveSocial();
    return update(interaction, await viewPayload({ ownerId: me, viewerId: me, key, page: 0, manage: true }));
  }

  if (kind === 'note') {
    const key = parts[3];
    const mid = parseInt(parts[4], 10);
    const item = social.getList(u, key)?.list.find((e) => e.mediaId === mid);
    const value = (interaction.fields.getTextInputValue('note') || '').trim();
    if (item) {
      if (key === 'recommendations') item.message = value || undefined;
      else item.note = value || undefined;
    }
    await ctx.saveSocial();
    return update(interaction, itemEditor(u, key, mid));
  }
}

/* --------------------------- picker purposes --------------------------- */

picker.registerPurpose('coll', {
  title: 'Add to list',
  async onPick(interaction, media, key) {
    const s = await ctx.loadSocial();
    const u = social.getUser(s, interaction.user.id);
    const r = social.getList(u, key);
    if (!r) return update(interaction, await viewPayload({ ownerId: interaction.user.id, viewerId: interaction.user.id, key: 'home', manage: true }));
    social.addItem(r.list, snapshot(media), key);
    await ctx.saveSocial();
    return update(interaction, await viewPayload({ ownerId: interaction.user.id, viewerId: interaction.user.id, key, page: Math.floor((r.list.length - 1) / PAGE), manage: true }));
  },
  async onCancel(interaction, key) {
    return update(interaction, await viewPayload({ ownerId: interaction.user.id, viewerId: interaction.user.id, key: key || 'home', manage: true }));
  },
});

picker.registerPurpose('rot', {
  title: 'Add to In Rotation',
  async onPick(interaction, media) {
    const s = await ctx.loadSocial();
    const u = social.getUser(s, interaction.user.id);
    if (!u.rotation.extra.some((x) => x.mediaId === media.id)) u.rotation.extra.push(snapshot(media));
    u.rotation.hidden = (u.rotation.hidden || []).filter((id) => id !== media.id);
    await ctx.saveSocial();
    return update(interaction, await viewPayload({ ownerId: interaction.user.id, viewerId: interaction.user.id, key: 'rotation', manage: true }));
  },
  async onCancel(interaction) {
    return update(interaction, await viewPayload({ ownerId: interaction.user.id, viewerId: interaction.user.id, key: 'rotation', manage: true }));
  },
});

module.exports = {
  PAGE,
  collectionBlocks,
  rotationBlocks,
  rotationEntries,
  homeBlocks,
  viewPayload,
  saveToPayload,
  onComponent,
  onModal,
  privacyPartFor,
  collectionModal,
};
