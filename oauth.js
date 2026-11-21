const crypto = require('crypto');
const express = require('express');
const { buildAuthorizeUrl, exchangeCodeForToken, getViewer } = require('./anilist');

/* ---------------------------------------------------------------------------
 * AniList sign-in ("/signin")
 *
 * Proves that a Discord user actually owns an AniList account, so things like
 * /tracking off can be restricted to the real owner of a profile.
 *
 * Flow:
 *   1. /signin replies (privately) with a link to AniList's authorize page.
 *      The link carries a signed `state` = who asked + an expiry, so the
 *      callback knows which Discord user is signing in and can't be forged.
 *   2. AniList sends the browser back to  <PUBLIC_URL>/auth/anilist/callback
 *   3. We swap the code for a token, ask AniList "who is this?" (Viewer),
 *      store the Discord <-> AniList link, and throw the token away — nothing
 *      here needs ongoing access to their account.
 *
 * Env:
 *   ANILIST_CLIENT_ID, ANILIST_CLIENT_SECRET  from anilist.co/settings/developer
 *   PUBLIC_URL (optional)  — falls back to Render's own RENDER_EXTERNAL_URL
 *   OAUTH_STATE_SECRET (optional) — falls back to DASHBOARD_SESSION_SECRET
 * ------------------------------------------------------------------------- */

const STATE_TTL_MS = 15 * 60 * 1000;
const CALLBACK_PATH = '/auth/anilist/callback';

function publicUrl() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
}

function redirectUri() {
  return `${publicUrl()}${CALLBACK_PATH}`;
}

function isOAuthConfigured() {
  return Boolean(process.env.ANILIST_CLIENT_ID && process.env.ANILIST_CLIENT_SECRET && publicUrl());
}

let fallbackSecret = null;
function stateSecret() {
  const s = process.env.OAUTH_STATE_SECRET || process.env.DASHBOARD_SESSION_SECRET;
  if (s) return s;
  if (!fallbackSecret) {
    console.warn('OAUTH_STATE_SECRET / DASHBOARD_SESSION_SECRET not set — sign-in links stop working after a restart.');
    fallbackSecret = crypto.randomBytes(32).toString('hex');
  }
  return fallbackSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signState(discordUserId, guildId) {
  const body = { u: discordUserId, e: Date.now() + STATE_TTL_MS, n: crypto.randomBytes(6).toString('hex') };
  if (guildId) body.g = String(guildId); // the server they signed in from (auto-track there)
  const payload = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.u || Date.now() > parsed.e) return null;
    return { userId: parsed.u, guildId: parsed.g || null };
  } catch {
    return null;
  }
}

function signInUrlFor(discordUserId, guildId = null) {
  return buildAuthorizeUrl({
    clientId: process.env.ANILIST_CLIENT_ID,
    redirectUri: redirectUri(),
    state: signState(discordUserId, guildId),
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resultPage({ ok, title, message, avatar }) {
  const accent = ok ? '#3db4f2' : '#fb7185';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AniTracker — ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b1622; color:#edf1f5;
         font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .card { width:min(420px, 92vw); background:#151f2e; border:1px solid #1f2b3d; border-radius:16px; padding:32px; text-align:center;
          box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .badge { width:64px; height:64px; border-radius:50%; margin:0 auto 16px; display:grid; place-items:center; font-size:30px;
           background: ${accent}22; color:${accent}; border:2px solid ${accent}; overflow:hidden; }
  .badge img { width:100%; height:100%; object-fit:cover; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#9fadbd; line-height:1.55; margin:0; }
  .brand { margin-top:24px; font-size:12px; color:#5c728a; letter-spacing:.04em; }
</style></head>
<body><main class="card">
  <div class="badge">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : ok ? '✓' : '!'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${message}</p>
  <div class="brand">✦ AniTracker</div>
</main></body></html>`;
}

// deps: { loadData, saveData, onLinked(discordUserId, account) }
function buildOAuthRouter(deps) {
  const { loadData, saveData, onLinked } = deps;
  const router = express.Router();

  router.get(CALLBACK_PATH, async (req, res) => {
    const { code, state, error } = req.query;
    const send = (status, page) => res.status(status).type('html').send(resultPage(page));

    if (error) {
      return send(400, { ok: false, title: 'Sign-in cancelled', message: 'No worries — nothing was linked. Run <b>/signin</b> again whenever you like.' });
    }
    if (!isOAuthConfigured()) {
      return send(500, { ok: false, title: 'Sign-in not set up', message: 'The bot owner hasn’t finished configuring AniList sign-in yet.' });
    }

    const verified = verifyState(state);
    const discordUserId = verified?.userId;
    const fromGuildId = verified?.guildId || null;
    if (!discordUserId) {
      return send(400, { ok: false, title: 'Link expired', message: 'That sign-in link is expired or invalid. Run <b>/signin</b> in Discord to get a fresh one.' });
    }
    if (!code || typeof code !== 'string') {
      return send(400, { ok: false, title: 'Something went wrong', message: 'AniList didn’t send back a sign-in code. Please try <b>/signin</b> again.' });
    }

    try {
      const token = await exchangeCodeForToken({
        clientId: process.env.ANILIST_CLIENT_ID,
        clientSecret: process.env.ANILIST_CLIENT_SECRET,
        redirectUri: redirectUri(),
        code,
      });
      const viewer = await getViewer(token);
      if (!viewer) throw new Error('AniList did not return the signed-in user');

      const data = await loadData();
      // One AniList account can only be linked to one Discord account.
      for (const [otherId, acct] of Object.entries(data.linkedAccounts)) {
        if (otherId !== discordUserId && acct.anilistId === viewer.id) delete data.linkedAccounts[otherId];
      }
      const account = {
        anilistId: viewer.id,
        anilistName: viewer.name,
        avatar: viewer.avatar?.medium || null,
        siteUrl: viewer.siteUrl,
        linkedAt: new Date().toISOString(),
        guildId: fromGuildId,
      };
      data.linkedAccounts[discordUserId] = account;
      await saveData(data);

      if (onLinked) Promise.resolve(onLinked(discordUserId, account, fromGuildId)).catch(() => {});

      return send(200, {
        ok: true,
        title: `Signed in as ${viewer.name}`,
        avatar: account.avatar,
        message: 'Your AniList account is now linked to AniTracker. You can close this tab and head back to Discord — try <b>/tracking</b>.',
      });
    } catch (e) {
      console.error('AniList OAuth callback failed:', e.message);
      return send(502, { ok: false, title: 'Couldn’t reach AniList', message: 'AniList didn’t respond properly. Give it a minute and run <b>/signin</b> again.' });
    }
  });

  return router;
}

module.exports = { buildOAuthRouter, signInUrlFor, isOAuthConfigured, redirectUri, CALLBACK_PATH };
