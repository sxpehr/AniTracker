const ui = require('./ui');
const social = require('./social');
const engine = require('./statsEngine');
const { ctx } = require('./ctx');
const artRoutes = require('./artRoutes');
const { getEntriesForMedia } = require('../anilist');
const { getMediaLite, titleOf } = require('./anilistSocial');

/* ---------------------------------------------------------------------------
 * /watched — find what people in this server have watched.
 *
 *   /watched                     everything the server has watched, most
 *                                watchers first (from AniTracker's history)
 *   /watched search:<words>      same list, filtered by title
 *   /watched anime:<title>       who here has it on their AniList — status,
 *                                how far, their score (live from AniList)
 *   /watched user:@someone       what that person watched, newest first
 *
 * ids: wt:a:<mediaId> · wt:open · wt:u:<userId>:<page> · wt:s:<page>:<query>
 * ------------------------------------------------------------------------- */

const ACCENT = 0x34d399;
const PAGE = 10;
const STATUS = {
  CURRENT: { label: 'Watching', emoji: '▶️', order: 0 },
  REPEATING: { label: 'Rewatching', emoji: '🔁', order: 1 },
  COMPLETED: { label: 'Completed', emoji: '✅', order: 2 },
  PAUSED: { label: 'Paused', emoji: '⏸️', order: 3 },
  DROPPED: { label: 'Dropped', emoji: '🗑️', order: 4 },
  PLANNING: { label: 'Plans to watch', emoji: '📌', order: 5 },
};

// Same people as the server recaps: tracked profiles + signed-in members.
function people(core, s, st, guildId) {
  return require('./recaps')._participants(core, s, st, guildId);
}

function who(p) {
  return p.ownerId ? `<@${p.ownerId}>` : `**${ui.esc(p.name)}**`;
}

// Every show anyone here has logged: { mediaId, watchers:Set, eps, last }
function serverHistory(st, list) {
  const shows = new Map();
  for (const p of list) {
    for (const [ym, m] of Object.entries(p.su?.months || {})) {
      for (const [id, eps] of Object.entries(m.a || {})) {
        const x = shows.get(id) || { mediaId: Number(id), watchers: new Set(), eps: 0, last: ym, ...(st.media[id] || {}) };
        x.watchers.add(p.anilistId);
        x.eps += eps;
        if (ym > x.last) x.last = ym;
        shows.set(id, x);
      }
    }
  }
  return [...shows.values()];
}

async function historyPayload(guildId, page = 0, query = '') {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const list = people(core, s, st, guildId);
  const q = (query || '').trim().toLowerCase();
  let shows = serverHistory(st, list).sort((a, b) => b.watchers.size - a.watchers.size || b.eps - a.eps);
  if (q) shows = shows.filter((x) => (x.t || '').toLowerCase().includes(q) || (x.tg || []).some((t) => t.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(shows.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = shows.slice(page * PAGE, page * PAGE + PAGE);
  const children = [
    ui.text(
      `-# 🔎 WATCHED IN THIS SERVER\n## ${q ? `“${ui.esc(ui.clip(query, 40))}”` : 'What this server watched'}\n-# ${shows.length} anime${q ? ' match' : ''} · ${list.length} watchers · from activity since AniTracker started tracking`
    ),
  ];
  if (!slice.length) children.push(ui.text(q ? '*Nobody here has watched anything matching that. Try `/watched anime:` to check AniList directly.*' : '*Nothing logged yet — history builds up as activity posts.*'));
  else {
    if (page === 0) {
      const top = slice.slice(0, 4);
      const bl = artRoutes.bannerListUrl(top.map((x) => ({ mediaId: x.mediaId, detail: `${x.watchers.size} watched · ${ui.num(x.eps)} eps` })));
      const g = bl ? ui.gallery([{ url: bl, description: top.map((x) => x.t).join(' · ') }]) : null;
      if (g) {
        artRoutes.warm(bl);
        children.push(g);
      }
    }
    children.push(
      ui.text(
        slice
          .map(
            (x, i) =>
              `\`${String(page * PAGE + i + 1).padStart(2, '0')}\` **${x.u ? `[${ui.esc(ui.clip(x.t || 'Unknown', 55))}](${x.u})` : ui.esc(x.t || 'Unknown')}**\n-# 👥 ${x.watchers.size} watched · ${ui.num(x.eps)} eps · last ${engine.monthName(x.last, false)}${x.tg?.length ? ` · ${x.tg.slice(0, 2).join(', ')}` : ''}`
          )
          .join('\n')
      )
    );
    children.push(ui.select('wt:open', 'See who watched it…', slice.map((x) => ({ label: ui.clip(x.t || `#${x.mediaId}`, 100), value: String(x.mediaId), description: `${x.watchers.size} watched · ${x.eps} eps` }))));
  }
  const qid = ui.clip(q.replace(/:/g, ' '), 40);
  children.push(
    ui.actionRow(
      ui.button(`wt:s:${page - 1}:${qid}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
      ui.button(`wt:s:${page + 1}:${qid}`, `Page ${page + 1}/${pages}`, { emoji: '▶️', disabled: page >= pages - 1 })
    )
  );
  return ui.fit([ui.card(ACCENT, children)]);
}

async function animePayload(guildId, mediaId) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const list = people(core, s, st, guildId);
  const media = await getMediaLite(mediaId).catch(() => null);
  const title = media ? titleOf(media) : st.media[mediaId]?.t || `AniList #${mediaId}`;
  const url = media?.siteUrl || `https://anilist.co/anime/${mediaId}`;
  let entries = null;
  try {
    entries = await getEntriesForMedia(mediaId, list.map((p) => p.anilistId));
  } catch (e) {
    console.error('Watched lookup failed:', e.message);
  }
  const byId = new Map(list.map((p) => [p.anilistId, p]));
  const rows = (entries || [])
    .map((e) => ({ ...e, p: byId.get(e.userId) }))
    .filter((e) => e.p)
    .sort((a, b) => (STATUS[a.status]?.order ?? 9) - (STATUS[b.status]?.order ?? 9) || (b.score || 0) - (a.score || 0));
  // AniList unreachable: fall back to what AniTracker logged.
  const logged = entries
    ? []
    : list
        .map((p) => ({ p, eps: Object.values(p.su?.months || {}).reduce((n, m) => n + (m.a?.[mediaId] || 0), 0) }))
        .filter((x) => x.eps > 0);

  const total = media?.episodes || null;
  const banner = media?.bannerImage || st.media[mediaId]?.b || null;
  const children = [
    banner ? ui.gallery([{ url: banner, description: title }]) : null,
    ui.text(
      [
        '-# 🔎 WHO WATCHED IT',
        `## [${ui.esc(ui.clip(title, 80))}](${url})`,
        entries ? `-# ${rows.length} of ${list.length} watchers here have it on AniList` : '-# ⚠️ AniList didn’t answer — showing what AniTracker logged instead',
      ].join('\n')
    ),
    ui.divider(),
  ].filter(Boolean);
  if (rows.length) {
    const groups = new Map();
    for (const r of rows) {
      const k = r.status || 'CURRENT';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const blocks = [];
    for (const [k, g] of groups) {
      const meta = STATUS[k] || { label: k, emoji: '📺' };
      blocks.push(
        `**${meta.emoji} ${meta.label}** · ${g.length}\n${g
          .slice(0, 12)
          .map((r) => {
            const prog = k === 'COMPLETED' ? (r.repeat ? `rewatched ${r.repeat}×` : '') : r.progress ? `${total ? `\`${ui.bar(r.progress, total, 8)}\` ` : ''}ep ${r.progress}${total ? `/${total}` : ''}` : '';
            return `${who(r.p)}${prog ? ` · ${prog}` : ''}${r.score ? ` · ⭐ ${Number(r.score).toFixed(1).replace(/\.0$/, '')}` : ''}`;
          })
          .join('\n')}`
      );
    }
    children.push(ui.text(blocks.join('\n\n')));
  } else if (logged.length) {
    children.push(ui.text(logged.map((x) => `${who(x.p)} · ${x.eps} eps logged`).join('\n')));
  } else {
    children.push(ui.text('*Nobody here has this on their AniList.*'));
  }
  children.push(ui.divider());
  children.push(ui.actionRow(ui.button(`rt:a:${mediaId}`, 'Ratings here', { emoji: '⭐' }), ui.button('wt:s:0:', 'Everything watched here', { emoji: '🔎' })));
  return ui.fit([ui.card(ACCENT, children)]);
}

async function userPayload(guildId, ownerId, viewerId, page = 0) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const u = social.peekUser(s, ownerId);
  if (!social.canView(u, viewerId, ownerId, 'activity')) return ui.notice({ accent: ACCENT, title: '🔒 Private', body: `<@${ownerId}> keeps their watch history private.` });
  const al = social.anilistFor(core, ownerId);
  const su = al ? st.users[String(al.id)] : null;
  const shows = new Map();
  for (const [ym, m] of Object.entries(su?.months || {})) {
    for (const [id, eps] of Object.entries(m.a || {})) {
      const x = shows.get(id) || { mediaId: Number(id), eps: 0, last: ym, ...(st.media[id] || {}) };
      x.eps += eps;
      if (ym > x.last) x.last = ym;
      shows.set(id, x);
    }
  }
  const list = [...shows.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : b.eps - a.eps));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  const children = [
    ui.text(`-# 🔎 WATCH HISTORY\n## ${ownerId === viewerId ? 'What you watched' : `What <@${ownerId}> watched`}\n-# ${list.length} anime since AniTracker started tracking${al ? ` · [AniList](${al.siteUrl})` : ''}`),
  ];
  if (!al) children.push(ui.text('*No AniList linked — `/signin` or `/track` first.*'));
  else if (!slice.length) children.push(ui.text('*Nothing logged yet.*'));
  else {
    if (page === 0) {
      const top = slice.slice(0, 4);
      const bl = artRoutes.bannerListUrl(top.map((x) => ({ mediaId: x.mediaId, detail: `${ui.num(x.eps)} eps · last ${engine.monthName(x.last, false)}` })));
      const g = bl ? ui.gallery([{ url: bl, description: top.map((x) => x.t).join(' · ') }]) : null;
      if (g) {
        artRoutes.warm(bl);
        children.push(g);
      }
    }
    children.push(
      ui.text(
        slice
          .map((x, i) => `\`${String(page * PAGE + i + 1).padStart(2, '0')}\` **${x.u ? `[${ui.esc(ui.clip(x.t || 'Unknown', 55))}](${x.u})` : ui.esc(x.t || 'Unknown')}**\n-# ${ui.num(x.eps)} eps · last ${engine.monthName(x.last, false)}`)
          .join('\n')
      )
    );
    children.push(ui.select('wt:open', 'Who else here watched it?', slice.map((x) => ({ label: ui.clip(x.t || `#${x.mediaId}`, 100), value: String(x.mediaId) }))));
  }
  children.push(
    ui.actionRow(
      ui.button(`wt:u:${ownerId}:${page - 1}`, 'Prev', { emoji: '◀️', disabled: page === 0 }),
      ui.button(`wt:u:${ownerId}:${page + 1}`, `Page ${page + 1}/${pages}`, { emoji: '▶️', disabled: page >= pages - 1 }),
      ui.button(`rt:u:${ownerId}:0:high`, 'Their ratings', { emoji: '⭐' })
    )
  );
  return ui.fit([ui.card(ACCENT, children)]);
}

async function handleCommand(interaction, { mediaId, user, query }) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply().catch(() => {});
  if (mediaId === -1) return ctx.respond(interaction, { content: 'Couldn’t find that anime on AniList — pick it from the suggestions while you type.' });
  if (mediaId) return ctx.respond(interaction, await animePayload(interaction.guildId, mediaId));
  if (user) return ctx.respond(interaction, await userPayload(interaction.guildId, user.id, interaction.user.id, 0));
  return ctx.respond(interaction, await historyPayload(interaction.guildId, 0, query || ''));
}

async function onComponent(interaction) {
  const parts = interaction.customId.split(':');
  const me = interaction.user.id;
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
      console.error('Watched view failed:', e.message);
    }
  };
  if (parts[1] === 'open') return show(() => animePayload(interaction.guildId, parseInt(interaction.values[0], 10)));
  if (parts[1] === 'a') return show(() => animePayload(interaction.guildId, parseInt(parts[2], 10)));
  if (parts[1] === 'u') return show(() => userPayload(interaction.guildId, parts[2], me, parseInt(parts[3], 10) || 0));
  if (parts[1] === 's') return show(() => historyPayload(interaction.guildId, parseInt(parts[2], 10) || 0, parts.slice(3).join(':')));
}

// Autocomplete before anything is typed: what this server actually watched.
async function suggestions(guildId, value) {
  const core = await ctx.loadData();
  const s = await ctx.loadSocial();
  const st = await ctx.loadStats();
  const q = (value || '').toLowerCase();
  return serverHistory(st, people(core, s, st, guildId))
    .filter((x) => x.t && x.t.toLowerCase().includes(q))
    .sort((a, b) => b.watchers.size - a.watchers.size || b.eps - a.eps)
    .slice(0, 25)
    .map((x) => ({ name: ui.clip(`${x.t} · ${x.watchers.size} watched here`, 100), value: String(x.mediaId) }));
}

module.exports = { handleCommand, onComponent, historyPayload, animePayload, userPayload, suggestions };
