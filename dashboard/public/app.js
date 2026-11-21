const API = '/dashboard/api';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ---------------- Loading helpers ---------------- */

// Fills a container with N shimmer rows while its real data is in flight, so
// a view swap never flashes an empty panel. Cleared by the render's own
// innerHTML reset once the data lands.
function showSkeletonRows(container, count = 4) {
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => '<div class="skeleton skeleton-row"></div>').join('');
}

function showSkeletonStats(container, count = 5) {
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => '<div class="skeleton skeleton-stat"></div>').join('');
}

// Wraps an async click handler so the button disables + shows a spinner for
// the duration, preventing double-submits on Send / Pause / Redeploy.
async function withButtonLoading(btn, fn) {
  if (!btn) return fn();
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = wasDisabled;
  }
}

/* ---------------- Auth ---------------- */

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  window.scrollTo(0, 0);
  loadView('overview');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password-input').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  errorEl.hidden = true;
  try {
    await withButtonLoading(submitBtn, () =>
      api('/login', { method: 'POST', body: JSON.stringify({ password }) })
    );
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------------- Sidebar collapse ---------------- */

const SIDEBAR_COLLAPSE_KEY = 'anitracker:sidebarCollapsed';

// No stored preference yet -> default collapsed on narrow/mobile widths, so
// first-time mobile visitors get the compact icon rail instead of a wall of
// full-label nav buttons.
function getStoredCollapse() {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (stored !== null) return stored === '1';
  } catch {}
  return window.innerWidth <= 900;
}

function setStoredCollapse(val) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, val ? '1' : '0');
  } catch {}
}

const sidebarEl = document.querySelector('.sidebar');
if (getStoredCollapse()) sidebarEl.classList.add('sidebar-collapsed');

const sidebarToggleBtn = document.getElementById('sidebar-toggle');
sidebarToggleBtn.setAttribute('aria-expanded', String(!sidebarEl.classList.contains('sidebar-collapsed')));
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = sidebarEl.classList.toggle('sidebar-collapsed');
  setStoredCollapse(collapsed);
  sidebarToggleBtn.setAttribute('aria-expanded', String(!collapsed));
});

/* ---------------- Nav ---------------- */

const viewTitles = {
  overview: 'Overview',
  servers: 'Servers',
  users: 'Tracked Users',
  activity: 'Recent Activity',
  leaderboards: 'Leaderboards',
  feedback: 'Feedback',
  send: 'Send Message',
  editstats: 'Edit Stats',
  announce: 'Announcement',
  controls: 'Bot Controls',
};

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => loadView(btn.dataset.view));
});

// Shared by the Overview page's "View all" shortcut on the Recent Activity snippet.
document.querySelectorAll('[data-goto-view]').forEach((btn) => {
  btn.addEventListener('click', () => loadView(btn.dataset.gotoView));
});

function loadView(view) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view-panel').forEach((p) => (p.hidden = p.dataset.viewPanel !== view));
  document.getElementById('view-title').textContent = viewTitles[view] || view;

  const renderers = {
    overview: renderOverview,
    servers: renderServers,
    users: renderUsers,
    activity: renderActivity,
    leaderboards: () => renderLeaderboard(currentTab),
    feedback: () => renderFeedback(currentFeedbackTab),
    send: renderSend,
    editstats: () => renderEditStats(currentStatsTab),
    announce: renderAnnounce,
    controls: renderControls,
  };
  const fn = renderers[view];
  if (!fn) return;
  // A failed request must never leave a panel stuck on loading shimmers.
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err.message === 'Not authenticated') return;
      const panel = document.querySelector(`[data-view-panel="${view}"]`);
      panel?.querySelectorAll('.skeleton').forEach((sk) => sk.remove());
      const box = panel?.querySelector('.list') || panel;
      if (box) box.prepend(el(`<div class="empty-state">Could not load this view: ${escapeHtml(err.message)}</div>`));
    });
}

/* ---------------- Overview ---------------- */

const RENDER_DASHBOARD_URL = 'https://dashboard.render.com/web/srv-d9pbdp2jnfac73ebhdq0';

async function renderOverview() {
  showSkeletonStats(document.getElementById('overview-stats'), 5);
  showSkeletonRows(document.getElementById('overview-activity-list'), 5);

  const data = await api('/overview');
  updateStatusPill(data.botPaused);

  const stats = document.getElementById('overview-stats');
  stats.innerHTML = '';
  const cards = [
    ['Servers', data.totalServers],
    ['Tracked Users', data.totalTrackedUsers],
    ['Linked Accounts', data.linkedAccounts ?? 0],
    ['Custom Profiles', data.profiles ?? 0],
    ['Reviews', data.reviews ?? 0],
    ['Recommend Votes', data.totalRecommendations],
    ['Pending Feedback', data.pendingFeedback ?? 0],
    ['Uptime', formatUptime(data.uptimeSeconds)],
  ];
  for (const [label, value] of cards) {
    stats.appendChild(el(`<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`));
  }

  const botCard = document.getElementById('overview-bot-card');
  botCard.innerHTML = '';
  botCard.appendChild(
    el(`
    <div class="list-row">
      ${data.botAvatar ? `<img class="avatar" src="${data.botAvatar}" />` : ''}
      <div class="row-main">
        <div class="row-title">${data.botTag || 'AniTracker'}</div>
        <div class="row-sub">${data.botPaused ? 'Polling paused' : 'Polling every few minutes'} · ${data.memoryMB ?? '?'} MB RAM · storage ${
          data.storage?.healthy ? escapeHtml(data.storage.backend) : '<span class="text-danger">UNAVAILABLE (read-only)</span>'
        }</div>
      </div>
      ${data.inviteUrl ? `<a class="btn btn-ghost btn-small" href="${data.inviteUrl}" target="_blank" rel="noopener">Invite link</a>` : ''}
      <a class="btn btn-ghost btn-small" href="${RENDER_DASHBOARD_URL}" target="_blank" rel="noopener">Open on Render →</a>
    </div>
  `)
  );
  botCard.appendChild(restartHistory(data.restarts || []));

  await renderOverviewActivitySnippet();
  wireSendForm({
    guildSelect: document.getElementById('overview-send-guild'),
    channelSelect: document.getElementById('overview-send-channel'),
    messageEl: document.getElementById('overview-send-message'),
    sendBtn: document.getElementById('overview-send-btn'),
    resultEl: document.getElementById('overview-send-result'),
  });
}

async function renderOverviewActivitySnippet() {
  const list = document.getElementById('overview-activity-list');
  list.innerHTML = '';
  try {
    const { activity } = await api('/activity?limit=5');
    if (!activity.length) return list.appendChild(el('<div class="empty-state">No activity posted yet.</div>'));
    for (const a of activity) list.appendChild(activityRow(a));
  } catch (err) {
    list.appendChild(el(`<div class="empty-state">Could not load activity: ${escapeHtml(err.message)}</div>`));
  }
}

// Recent process starts, and how each one ended — the quickest way to tell a
// normal deploy apart from a crash / out-of-memory kill.
function restartHistory(restarts) {
  const wrapEl = el('<div class="restart-history"><h3>Recent restarts</h3><div class="list"></div></div>');
  const list = wrapEl.querySelector('.list');
  if (!restarts.length) {
    list.appendChild(el('<div class="empty-state">No restart history recorded yet.</div>'));
    return wrapEl;
  }
  restarts.forEach((r, i) => {
    let label, cls;
    if (i === 0 && !r.endedAt) {
      label = 'Running now';
      cls = 'feedback-badge-resolved';
    } else if (r.reason && r.reason.startsWith('unexpected')) {
      label = 'Crashed / killed';
      cls = 'feedback-badge-disputed';
    } else {
      label = 'Clean stop';
      cls = 'feedback-badge-new';
    }
    const ran = r.endedAt ? formatUptime((new Date(r.endedAt) - new Date(r.startedAt)) / 1000) : null;
    list.appendChild(
      el(`<div class="list-row">
        <span class="badge ${cls}">${label}</span>
        <div class="row-main">
          <div class="row-title">Started ${new Date(r.startedAt).toLocaleString()}</div>
          <div class="row-sub">${r.commit ? `commit ${escapeHtml(r.commit)} · ` : ''}${ran ? `ran ${ran} · ` : ''}${escapeHtml(r.reason || '')}</div>
        </div>
      </div>`)
    );
  });
  return wrapEl;
}

function formatUptime(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(seconds / 86400);
  if (d >= 1) return `${d}d ${Math.floor((seconds % 86400) / 3600)}h`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 1) return `${m}m`;
  return `${h}h ${m}m`;
}

function updateStatusPill(paused) {
  const pill = document.getElementById('bot-status-pill');
  pill.textContent = paused ? '● Paused' : '● Running';
  pill.classList.toggle('status-running', !paused);
  pill.classList.toggle('status-paused', paused);
}

/* ---------------- Servers ---------------- */

async function renderServers() {
  showSkeletonRows(document.getElementById('servers-list'), 5);
  const { servers } = await api('/servers');
  document.getElementById('servers-count').textContent = servers.length;
  const list = document.getElementById('servers-list');
  list.innerHTML = '';
  if (!servers.length) return list.appendChild(el('<div class="empty-state">No servers yet.</div>'));
  for (const s of servers) {
    list.appendChild(
      el(`
      <div class="list-row">
        ${s.icon ? `<img class="avatar" src="${s.icon}" />` : '<div class="avatar"></div>'}
        <div class="row-main">
          <div class="row-title">${escapeHtml(s.name)}</div>
          <div class="row-sub">${s.channelName ? `Posting in ${escapeHtml(s.channelName)}` : 'No channel set'} · ${s.memberCount ?? '?'} members</div>
        </div>
        <div class="row-count">${s.trackedUserCount} tracked</div>
      </div>
    `)
    );
  }
}

/* ---------------- Users ---------------- */

async function renderUsers() {
  showSkeletonRows(document.getElementById('users-list'), 5);
  const { users, total } = await api('/users');
  document.getElementById('users-count').textContent = total;
  const list = document.getElementById('users-list');
  list.innerHTML = '';
  if (!users.length) return list.appendChild(el('<div class="empty-state">No one tracked yet.</div>'));
  for (const u of users) {
    list.appendChild(
      el(`
      <div class="list-row">
        ${u.avatar ? `<img class="avatar" src="${u.avatar}" />` : '<div class="avatar"></div>'}
        <div class="row-main">
          <div class="row-title">${escapeHtml(u.username)}</div>
          <div class="row-sub">${escapeHtml(u.guildName)}${u.streak ? ` · 🔥${u.streak}` : ''}${u.linked ? ' · 🔐 linked' : ''}</div>
        </div>
        ${u.trackingOff ? '<span class="badge feedback-badge-disputed">Live activity off</span>' : ''}
        ${u.addedBy ? `<div class="row-count">by ${escapeHtml(u.addedByName || u.addedBy)}</div>` : ''}
      </div>
    `)
    );
  }
}

/* ---------------- Activity ---------------- */

function activityRow(a) {
  return el(`
    <div class="list-row">
      ${a.cover ? `<img class="avatar avatar-cover" src="${escapeHtml(a.cover)}" alt="" loading="lazy" />` : ''}
      <div class="row-main">
        <div class="row-title">${escapeHtml(a.animeTitle || 'Activity update')}</div>
        <div class="row-sub">${escapeHtml(a.guildName)}${a.addedBy ? ` · tracked for ${escapeHtml(a.addedByName || a.addedBy)}` : ''}</div>
      </div>
      <div class="row-count">${timeAgo(a.postedAt)}</div>
    </div>
  `);
}

async function renderActivity() {
  showSkeletonRows(document.getElementById('activity-list'), 8);
  const { activity } = await api('/activity?limit=100');
  const list = document.getElementById('activity-list');
  list.innerHTML = '';
  if (!activity.length) return list.appendChild(el('<div class="empty-state">No activity posted yet.</div>'));
  for (const a of activity) list.appendChild(activityRow(a));
}

/* ---------------- Leaderboards ---------------- */

let currentTab = 'recommended';
document.querySelectorAll('[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    currentTab = tab.dataset.tab;
    renderLeaderboard(currentTab);
  });
});

async function renderLeaderboard(tab) {
  const content = document.getElementById('leaderboard-content');
  const noteEl = document.getElementById('leaderboard-note');
  showSkeletonRows(content, 6);
  noteEl.textContent = '';

  if (tab === 'recommended' || tab === 'watched') {
    const { list, note } = await api(`/leaderboards/${tab}`);
    content.innerHTML = '';
    noteEl.textContent = note || '';
    if (!list.length) return content.appendChild(el('<div class="empty-state">Nothing yet.</div>'));
    list.forEach((item, i) => {
      content.appendChild(
        el(`
        <div class="list-row">
          <div class="rank">${i + 1}</div>
          <div class="row-main">
            <div class="row-title">${item.siteUrl ? `<a href="${escapeHtml(item.siteUrl)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</div>
          </div>
          <div class="row-count">${item.count} ${tab === 'watched' ? 'updates' : 'votes'}</div>
        </div>
      `)
      );
    });
  } else if (tab === 'watchlater') {
    const { users } = await api('/leaderboards/watchlater');
    content.innerHTML = '';
    if (!users.length) return content.appendChild(el('<div class="empty-state">No watch-later lists yet.</div>'));
    for (const u of users) {
      content.appendChild(
        el(`
        <div class="list-row">
          <div class="row-main">
            <div class="row-title">${escapeHtml(u.userName || u.userId)}</div>
            <div class="row-sub">${escapeHtml(u.titles.map((t) => t.title).join(', '))}</div>
          </div>
          <div class="row-count">${u.count}</div>
        </div>
      `)
      );
    }
  } else if (tab === 'linked') {
    const { accounts, note } = await api('/leaderboards/linked');
    content.innerHTML = '';
    noteEl.textContent = note || '';
    if (!accounts.length) return content.appendChild(el('<div class="empty-state">No one has linked their AniList with /signin yet.</div>'));
    for (const a of accounts) {
      content.appendChild(
        el(`<div class="list-row">
          ${a.avatar ? `<img class="avatar" src="${escapeHtml(a.avatar)}" alt="" />` : '<div class="avatar"></div>'}
          <div class="row-main">
            <div class="row-title"><a href="${escapeHtml(a.siteUrl)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${escapeHtml(a.anilistName)}</a></div>
            <div class="row-sub">Discord: ${escapeHtml(a.discordName || a.discordId)} · linked ${timeAgo(a.linkedAt)}</div>
          </div>
          ${a.trackingOff ? '<span class="badge feedback-badge-disputed">Live activity off</span>' : '<span class="badge feedback-badge-resolved">Live activity on</span>'}
        </div>`)
      );
    }
  }
}

/* ---------------- Feedback ---------------- */

let currentFeedbackTab = 'all';
document.querySelectorAll('[data-feedback-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-feedback-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    currentFeedbackTab = btn.dataset.feedbackTab;
    renderFeedback(currentFeedbackTab);
  });
});

const FEEDBACK_STATUS_LABELS = { resolved: 'Resolved', disputed: 'Disputed', later: 'Keep for Later' };

function feedbackCard(f) {
  const stars = f.rating
    ? `${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} <span class="muted-note">${f.rating}/5</span>`
    : '<span class="muted-note">No rating given</span>';
  const statusLabel = FEEDBACK_STATUS_LABELS[f.status] || 'New';
  const fromDiscord = f.source === 'discord';
  const who = fromDiscord
    ? `<span class="feedback-who">${f.userAvatar ? `<img class="avatar avatar-xs" src="${escapeHtml(f.userAvatar)}" alt="" />` : ''}${escapeHtml(f.userName || 'Unknown user')}${
        f.guildName ? ` <span class="muted-note">in ${escapeHtml(f.guildName)}</span>` : ''
      }</span>`
    : `<span class="muted-note">Contact: ${f.contact ? escapeHtml(f.contact) : '—'}</span>`;

  const node = el(`
    <div class="card feedback-card">
      <div class="card-header">
        <span class="badge feedback-badge-${f.status || 'new'}">${statusLabel}</span>
        <span class="badge feedback-source">${fromDiscord ? '/feedback' : 'Website'}</span>
        <span class="muted-note feedback-time" title="${escapeHtml(new Date(f.postedAt).toLocaleString())}">${timeAgo(f.postedAt)}</span>
      </div>
      <div class="feedback-rating">${stars}</div>
      ${f.title ? `<h3 class="feedback-title">${escapeHtml(f.title)}</h3>` : ''}
      <p class="feedback-content">${escapeHtml(f.content)}</p>
      <div class="feedback-meta">${who}</div>
      <div class="feedback-actions"></div>
    </div>
  `);

  const actions = node.querySelector('.feedback-actions');
  const actionDefs = [
    ['resolved', 'Resolve', 'btn-primary'],
    ['disputed', 'Dispute', 'btn-danger'],
    ['later', 'Keep for Later', 'btn-ghost'],
  ].filter(([status]) => status !== f.status);
  if (f.status) actionDefs.push([null, 'Reset to New', 'btn-ghost']);

  for (const [status, label, cls] of actionDefs) {
    const btn = el(`<button class="btn ${cls} btn-small">${label}</button>`);
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/feedback/${encodeURIComponent(f.id)}/status`, { method: 'POST', body: JSON.stringify({ status }) });
        renderFeedback(currentFeedbackTab);
      } catch (err) {
        btn.disabled = false;
        alert(`Error: ${err.message}`);
      }
    };
    actions.appendChild(btn);
  }

  if (fromDiscord) {
    const del = el('<button class="btn btn-ghost btn-small feedback-delete">Delete</button>');
    del.onclick = async () => {
      if (!confirm('Delete this feedback permanently?')) return;
      del.disabled = true;
      try {
        await api(`/feedback/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
        renderFeedback(currentFeedbackTab);
      } catch (err) {
        del.disabled = false;
        alert(`Error: ${err.message}`);
      }
    };
    actions.appendChild(del);
  }

  return node;
}

async function renderFeedback(tab) {
  const list = document.getElementById('feedback-list');
  showSkeletonRows(list, 4);
  let feedback;
  try {
    ({ feedback } = await api('/feedback'));
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el(`<div class="empty-state">Could not load feedback: ${escapeHtml(err.message)}</div>`));
    return;
  }
  list.innerHTML = '';

  const filtered =
    tab === 'all' ? feedback : tab === 'new' ? feedback.filter((f) => !f.status) : feedback.filter((f) => f.status === tab);

  if (!filtered.length) return list.appendChild(el('<div class="empty-state">No feedback here.</div>'));
  for (const f of filtered) list.appendChild(feedbackCard(f));
}

/* ---------------- Send message ---------------- */

// Shared by the full Send Message view and the Overview page's Quick Send
// snippet, so both stay in sync with a single implementation.
async function wireSendForm({ guildSelect, channelSelect, messageEl, sendBtn, resultEl }) {
  async function populateChannels(guildId) {
    if (!guildId) return (channelSelect.innerHTML = '');
    const { channels } = await api(`/servers/${guildId}/channels`);
    channelSelect.innerHTML = channels.map((c) => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
  }

  const { servers } = await api('/servers');
  guildSelect.innerHTML = servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  await populateChannels(servers[0]?.id);
  guildSelect.onchange = () => populateChannels(guildSelect.value);

  sendBtn.onclick = async () => {
    resultEl.textContent = 'Sending…';
    try {
      await withButtonLoading(sendBtn, () =>
        api('/send', {
          method: 'POST',
          body: JSON.stringify({
            guildId: guildSelect.value,
            channelId: channelSelect.value,
            message: messageEl.value,
          }),
        })
      );
      resultEl.textContent = 'Sent ✓';
      messageEl.value = '';
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
}

async function renderSend() {
  await wireSendForm({
    guildSelect: document.getElementById('send-guild'),
    channelSelect: document.getElementById('send-channel'),
    messageEl: document.getElementById('send-message'),
    sendBtn: document.getElementById('send-btn'),
    resultEl: document.getElementById('send-result'),
  });
}

/* ---------------- Edit stats ---------------- */

let currentStatsTab = 'watched';
document.querySelectorAll('[data-stats-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-stats-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    currentStatsTab = btn.dataset.statsTab;
    renderEditStats(currentStatsTab);
  });
});

function editRow({ cover, title, url, sub, value, onSave }) {
  const row = el(`
    <div class="list-row">
      ${cover ? `<img class="es-cover" src="${escapeHtml(cover)}" alt="" />` : '<div class="es-cover"></div>'}
      <div class="row-main">
        <div class="row-title">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>` : escapeHtml(title)}</div>
        <div class="row-sub">${escapeHtml(sub || '')}</div>
      </div>
      <div class="es-edit">
        <input type="number" min="0" value="${Number(value) || 0}" aria-label="New value for ${escapeHtml(title)}" />
        <button class="btn btn-primary">Save</button>
      </div>
    </div>`);
  const input = row.querySelector('input');
  const btn = row.querySelector('button');
  const save = () => withButtonLoading(btn, () => onSave(Number(input.value), row));
  btn.onclick = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') save();
  };
  return row;
}

async function renderEditStats(tab) {
  document.getElementById('es-watched').hidden = tab !== 'watched';
  document.getElementById('es-people').hidden = tab !== 'people';
  if (tab === 'watched') return renderWatchedEditor();
  return renderPeopleEditor();
}

async function renderWatchedEditor() {
  const listEl = document.getElementById('es-watched-list');
  const resultEl = document.getElementById('es-watched-result');
  const search = document.getElementById('es-watched-search');
  const load = async () => {
    showSkeletonRows(listEl, 6);
    const { list, total } = await api(`/stats/watched?q=${encodeURIComponent(search.value.trim())}`);
    listEl.innerHTML = '';
    if (!list.length) return listEl.appendChild(el('<div class="empty-state">No shows match.</div>'));
    if (total > list.length) resultEl.textContent = `Showing the top ${list.length} of ${total}. Search to find others.`;
    list.forEach((item) =>
      listEl.appendChild(
        editRow({
          cover: item.cover,
          title: item.title,
          url: item.siteUrl,
          sub: `AniList #${item.mediaId} · ${item.count} updates`,
          value: item.count,
          onSave: async (count, row) => {
            try {
              const r = await api(`/stats/watched/${item.mediaId}`, { method: 'PUT', body: JSON.stringify({ count }) });
              resultEl.textContent = r.removed ? `Removed ${item.title}.` : `Saved: ${item.title} → ${r.entry.count}`;
              if (r.removed) row.remove();
              else row.querySelector('.row-sub').textContent = `AniList #${item.mediaId} · ${r.entry.count} updates`;
            } catch (err) {
              resultEl.textContent = `Error: ${err.message}`;
            }
          },
        })
      )
    );
  };
  let t = null;
  search.oninput = () => {
    clearTimeout(t);
    t = setTimeout(load, 300);
  };
  const addBtn = document.getElementById('es-add-btn');
  addBtn.onclick = () =>
    withButtonLoading(addBtn, async () => {
      const id = Number(document.getElementById('es-add-id').value);
      const count = Number(document.getElementById('es-add-count').value);
      try {
        const r = await api(`/stats/watched/${id}`, { method: 'PUT', body: JSON.stringify({ count }) });
        resultEl.textContent = r.removed ? 'Removed.' : `Saved: ${r.entry.title} → ${r.entry.count}`;
        await load();
      } catch (err) {
        resultEl.textContent = `Error: ${err.message}`;
      }
    });
  await load();
}

async function renderPeopleEditor() {
  const select = document.getElementById('es-person');
  const listEl = document.getElementById('es-person-list');
  const totalsEl = document.getElementById('es-person-totals');
  const resultEl = document.getElementById('es-person-result');
  const search = document.getElementById('es-person-search');
  const { users } = await api('/stats/users');
  if (!users.length) {
    select.innerHTML = '';
    listEl.innerHTML = '<div class="empty-state">No stats recorded yet.</div>';
    return;
  }
  const keep = select.value;
  select.innerHTML = users.map((u) => `<option value="${u.anilistId}">${escapeHtml(u.name)} · ${u.episodes} eps${u.edits ? ' · edited' : ''}</option>`).join('');
  if (keep && users.some((u) => String(u.anilistId) === keep)) select.value = keep;
  let anime = [];
  const showTotals = (t) => {
    totalsEl.innerHTML = `<span><b>${t.episodes}</b> episodes</span><span><b>${Math.round(t.minutes / 60)}</b> hours</span><span><b>${t.anime}</b> anime</span><span><b>${t.completed}</b> completed</span><span><b>${t.months}</b> months</span>`;
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    listEl.innerHTML = '';
    const shown = anime.filter((a) => !q || a.title.toLowerCase().includes(q) || String(a.mediaId) === q);
    if (!shown.length) return listEl.appendChild(el('<div class="empty-state">No shows.</div>'));
    for (const a of shown.slice(0, 200)) {
      listEl.appendChild(
        editRow({
          cover: a.cover,
          title: a.title,
          url: `https://anilist.co/anime/${a.mediaId}`,
          sub: `AniList #${a.mediaId} · ${a.eps} eps · ${a.months.length} month${a.months.length === 1 ? '' : 's'}${a.freaky ? ' · counts as freaky' : ''}`,
          value: a.eps,
          onSave: (eps) => saveEps(a.mediaId, eps, a.title),
        })
      );
    }
  };
  const load = async () => {
    showSkeletonRows(listEl, 6);
    const data = await api(`/stats/users/${select.value}`);
    anime = data.anime;
    showTotals(data.totals);
    draw();
  };
  const saveEps = async (mediaId, episodes, title) => {
    try {
      const r = await api(`/stats/users/${select.value}/anime/${mediaId}`, { method: 'PUT', body: JSON.stringify({ episodes }) });
      resultEl.textContent = `Saved: ${title || `#${mediaId}`} ${r.before} → ${r.after} episodes`;
      await load();
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
  select.onchange = load;
  search.oninput = draw;
  const addBtn = document.getElementById('es-person-add-btn');
  addBtn.onclick = () =>
    withButtonLoading(addBtn, () => saveEps(Number(document.getElementById('es-person-add-id').value), Number(document.getElementById('es-person-add-eps').value)));
  await load();
}

/* ---------------- Announcement ---------------- */

let announcePoll = null;

async function renderAnnounce() {
  const targetsEl = document.getElementById('an-targets');
  const countEl = document.getElementById('an-count');
  const testSel = document.getElementById('an-test-guild');
  const resultEl = document.getElementById('an-result');
  const reportEl = document.getElementById('an-report');
  const progress = document.getElementById('an-progress');
  const bar = document.getElementById('an-progress-bar');
  showSkeletonRows(targetsEl, 6);
  const t = await api('/announce/targets');
  countEl.textContent = `${t.reachable} / ${t.total}`;
  targetsEl.innerHTML = '';
  for (const g of t.servers) {
    targetsEl.appendChild(
      el(`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(g.name)}</div><div class="row-sub">${g.channel ? `${escapeHtml(g.channel)} · ${escapeHtml(g.how)}` : 'No channel the bot can post in'}${g.members ? ` · ${g.members} members` : ''}</div></div></div>`)
    );
  }
  testSel.innerHTML = t.servers.filter((g) => g.channel).map((g) => `<option value="${g.guildId}">${escapeHtml(g.name)}</option>`).join('');

  const body = (test) =>
    JSON.stringify({
      title: document.getElementById('an-title').value.trim(),
      message: document.getElementById('an-message').value,
      imageUrl: document.getElementById('an-image').value.trim() || null,
      onlyConfigured: document.getElementById('an-only').checked,
      test: test || null,
    });

  const watch = () => {
    clearInterval(announcePoll);
    progress.hidden = false;
    announcePoll = setInterval(async () => {
      try {
        const st = await api('/announce/status');
        bar.style.width = `${st.total ? Math.round((st.done / st.total) * 100) : 100}%`;
        resultEl.textContent = st.running ? `Sending… ${st.done} / ${st.total}` : `${st.test ? 'Test sent' : 'Done'}: ${st.sent} sent · ${st.failed.length} failed · ${st.skipped.length} skipped`;
        if (!st.running) {
          clearInterval(announcePoll);
          reportEl.innerHTML = '';
          for (const f of [...st.failed.map((x) => ({ ...x, kind: 'Failed' })), ...st.skipped.map((x) => ({ ...x, kind: 'Skipped' }))]) {
            reportEl.appendChild(el(`<div class="list-row"><div class="row-main"><div class="row-title">${escapeHtml(f.name)}</div><div class="row-sub">${f.kind}: ${escapeHtml(f.reason)}</div></div></div>`));
          }
        }
      } catch {
        clearInterval(announcePoll);
      }
    }, 1000);
  };

  document.getElementById('an-test-btn').onclick = async (e) => {
    try {
      await withButtonLoading(e.currentTarget, () => api('/announce', { method: 'POST', body: body(testSel.value) }));
      watch();
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
  document.getElementById('an-send-btn').onclick = async (e) => {
    const n = document.getElementById('an-only').checked ? t.configured : t.reachable;
    if (!confirm(`Send this announcement to ${n} server${n === 1 ? '' : 's'}? This can't be undone.`)) return;
    try {
      await withButtonLoading(e.currentTarget, () => api('/announce', { method: 'POST', body: body(null) }));
      watch();
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
}

/* ---------------- Controls ---------------- */

async function renderControls() {
  const { botPaused } = await api('/overview');
  const btn = document.getElementById('pause-resume-btn');
  btn.textContent = botPaused ? 'Resume' : 'Pause';

  btn.onclick = async () => {
    const resultEl = document.getElementById('controls-result');
    try {
      const { botPaused: nowPaused } = await withButtonLoading(btn, () =>
        api(botPaused ? '/resume' : '/pause', { method: 'POST' })
      );
      updateStatusPill(nowPaused);
      resultEl.textContent = nowPaused ? 'Bot paused.' : 'Bot resumed.';
      renderControls();
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };

  const redeployBtn = document.getElementById('redeploy-btn');
  redeployBtn.onclick = async () => {
    const resultEl = document.getElementById('controls-result');
    if (!confirm('Trigger a redeploy on Render now?')) return;
    resultEl.textContent = 'Triggering redeploy…';
    try {
      await withButtonLoading(redeployBtn, () => api('/redeploy', { method: 'POST' }));
      resultEl.textContent = 'Redeploy triggered ✓';
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
}

/* ---------------- Utils ---------------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Boot ---------------- */

(async function boot() {
  try {
    const { authenticated } = await api('/me');
    if (authenticated) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
