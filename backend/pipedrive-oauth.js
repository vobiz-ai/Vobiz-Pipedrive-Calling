/**
 * Pipedrive OAuth 2.0, one grant per Pipedrive company.
 *
 * Marketplace listing requires this. The approval checklist is explicit: "Your
 * app implements and primarily uses OAuth 2.0 for both authentication and
 * request authorization", and "No collection or storage of API tokens". This
 * integration previously used a personal API token exclusively, which cannot be
 * listed no matter how well the rest of it works.
 *
 * Flow (both behind the admin check in server.js):
 *   GET  /auth/pipedrive[?authId=MA_…]  -> redirect to Pipedrive's consent screen
 *   GET  /auth/pipedrive/callback       -> exchange ?code for tokens
 *
 * Grants live in the encrypted token store (token-store.js), keyed by the
 * Pipedrive company id that /users/me reports for the new token. A second
 * company connecting gets its own record; it never replaces the first.
 *
 * Which company a call is logged to: the company whose `vobizAuthIds` lists
 * the call's Vobiz account. Failing that, a company linked to no account at
 * all is the default for every account no company claims — but only while it
 * is the only unlinked one, so two unlinked companies are never guessed
 * between. On a shared host, connect each company with ?authId= so nothing
 * relies on the default.
 *
 * Access tokens last 60 minutes. Refresh tokens expire only if unused for 60
 * days, and each use resets that window. Every API call goes through
 * `pipedriveFetch`, which refreshes on demand and retries once — so a token
 * expiring mid-request is invisible to callers rather than a random 401.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createTokenStore } = require("./token-store");

// PIPEDRIVE_OAUTH_URL exists for the test suite's fake token endpoint.
const OAUTH_BASE = (process.env.PIPEDRIVE_OAUTH_URL || "https://oauth.pipedrive.com").replace(/\/+$/, "");
const AUTHORIZE_URL = `${OAUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${OAUTH_BASE}/oauth/token`;

// The plaintext single-grant file older versions wrote. Imported into the
// encrypted store once, then deleted.
const LEGACY_TOKEN_FILE = process.env.PIPEDRIVE_LEGACY_TOKEN_FILE || path.join(__dirname, ".pipedrive-tokens.json");
const LEGACY_COMPANY_ID = "legacy";

let store = null;

/** Point the module at its store. server.js calls this once at start-up. */
function configure({ file, key } = {}) {
  store = createTokenStore({ file, key });
  migrateLegacyFile();
}

function getStore() {
  if (!store) configure({ file: process.env.PIPEDRIVE_TOKEN_STORE });
  return store;
}

function migrateLegacyFile() {
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_TOKEN_FILE, "utf8"));
  } catch {
    return;
  }
  if (!legacy || !legacy.refresh_token) return;
  try {
    store.put(LEGACY_COMPANY_ID, {
      accessToken: legacy.access_token,
      refreshToken: legacy.refresh_token,
      expiresAt: legacy.expires_at || 0,
      apiDomain: legacy.api_domain || null,
      scope: legacy.scope || null,
      vobizAuthIds: [],
      connectedAt: new Date().toISOString(),
    });
    fs.unlinkSync(LEGACY_TOKEN_FILE);
    console.log(`[pipedrive-oauth] moved the plaintext grant in ${LEGACY_TOKEN_FILE} into the encrypted store`);
  } catch (err) {
    console.error(`[pipedrive-oauth] could not migrate ${LEGACY_TOKEN_FILE}: ${err.message}. It still holds a plaintext token; set TOKEN_ENCRYPTION_KEY and restart.`);
  }
}

// Outstanding `state` values, so a callback cannot be forged or replayed. Each
// carries the Vobiz account the admin asked to link, if any.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function isConfigured(env) {
  return Boolean(env.PIPEDRIVE_CLIENT_ID && env.PIPEDRIVE_CLIENT_SECRET && env.PIPEDRIVE_REDIRECT_URI);
}

function companies() {
  return getStore().listPublic();
}

/** The company id whose grant serves this Vobiz account, or null. */
function companyFor(authId) {
  const all = companies();
  const linked = authId && all.find((c) => Array.isArray(c.vobizAuthIds) && c.vobizAuthIds.includes(authId));
  if (linked) return linked.companyId;
  const unlinked = all.filter((c) => !Array.isArray(c.vobizAuthIds) || c.vobizAuthIds.length === 0);
  return unlinked.length === 1 ? unlinked[0].companyId : null;
}

/** Is this company id linked to this Vobiz account explicitly (not by default)? */
function isLinked(companyId, authId) {
  const rec = companies().find((c) => c.companyId === companyId);
  return Boolean(rec && authId && Array.isArray(rec.vobizAuthIds) && rec.vobizAuthIds.includes(authId));
}

function isConnected(authId) {
  return Boolean(companyFor(authId));
}

function anyConnected() {
  return companies().length > 0;
}

function buildAuthorizeUrl(env, { authId } = {}) {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, { issued: Date.now(), authId: authId || null });
  for (const [k, v] of pendingStates) {
    if (Date.now() - v.issued > STATE_TTL_MS) pendingStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id: env.PIPEDRIVE_CLIENT_ID,
    redirect_uri: env.PIPEDRIVE_REDIRECT_URI,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** The pending flow for this state ({ authId }), or null. One use only. */
function consumeState(state) {
  if (!state || !pendingStates.has(state)) return null;
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - pending.issued <= STATE_TTL_MS ? { authId: pending.authId } : null;
}

function basicAuth(env) {
  return "Basic " + Buffer.from(`${env.PIPEDRIVE_CLIENT_ID}:${env.PIPEDRIVE_CLIENT_SECRET}`).toString("base64");
}

async function postToken(env, body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `token endpoint returned ${res.status}`);
  }
  return json;
}

function tokenFields(json, previous) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || (previous && previous.refreshToken),
    // 30s of headroom, so a call started just before expiry does not race it.
    expiresAt: Date.now() + (Number(json.expires_in || 3600) - 30) * 1000,
    apiDomain: json.api_domain || (previous && previous.apiDomain) || null,
    scope: json.scope || (previous && previous.scope) || null,
  };
}

const apiBase = (apiDomain) => String(apiDomain || "https://api.pipedrive.com").replace(/\/+$/, "");

/**
 * Exchange the code, ask Pipedrive which company the grant is for, and store
 * it under that company. Re-authorising a company updates its record and
 * keeps its links; `authId` adds one.
 */
async function exchangeCode(env, code, { authId } = {}) {
  const json = await postToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.PIPEDRIVE_REDIRECT_URI,
  });
  const meRes = await fetch(`${apiBase(json.api_domain)}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${json.access_token}`, Accept: "application/json" },
  });
  const me = await meRes.json().catch(() => ({}));
  const companyId = me && me.data && me.data.company_id != null ? String(me.data.company_id) : "";
  if (!meRes.ok || !companyId) throw new Error(`could not read the Pipedrive company for this grant (HTTP ${meRes.status})`);

  const existing = getStore().get(companyId);
  const links = new Set((existing && existing.vobizAuthIds) || []);
  if (authId) links.add(authId);
  // A connect for an account moves that account off any other company, so it
  // is never linked to two.
  if (authId) {
    for (const c of companies()) {
      if (c.companyId !== companyId && Array.isArray(c.vobizAuthIds) && c.vobizAuthIds.includes(authId)) {
        getStore().put(c.companyId, { vobizAuthIds: c.vobizAuthIds.filter((a) => a !== authId) });
      }
    }
  }
  getStore().put(companyId, {
    ...tokenFields(json, existing),
    companyDomain: me.data.company_domain || (existing && existing.companyDomain) || null,
    companyName: me.data.company_name || (existing && existing.companyName) || null,
    vobizAuthIds: [...links],
    connectedAt: (existing && existing.connectedAt) || new Date().toISOString(),
  });
  return publicRecord(companyId);
}

async function refresh(env, companyId) {
  const current = getStore().get(companyId);
  if (!current || !current.refreshToken) throw new Error("Not connected to Pipedrive");
  const json = await postToken(env, {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });
  const next = getStore().put(companyId, tokenFields(json, current));
  console.log(`[pipedrive-oauth] access token refreshed for company ${companyId}`);
  return next;
}

async function accessToken(env, companyId) {
  const current = getStore().get(companyId);
  if (!current) throw new Error("Not connected to Pipedrive");
  if (!current.accessToken || !current.expiresAt || Date.now() >= current.expiresAt) {
    return (await refresh(env, companyId)).accessToken;
  }
  return current.accessToken;
}

/**
 * The one way this integration should talk to Pipedrive.
 *
 * `api_domain` comes from the token response and already encodes the customer's
 * company domain — hardcoding api.pipedrive.com works for some accounts and
 * silently 404s for others.
 */
async function pipedriveFetch(env, companyId, apiPath, options = {}, retried = false) {
  const token = await accessToken(env, companyId);
  const base = apiBase(getStore().get(companyId).apiDomain);
  const url = `${base}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      // JSON by default; a FormData body (recording upload) sets its own
      // multipart boundary and must not be overridden.
      ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  // One retry on 401: the token can expire between our check and the request.
  if (res.status === 401 && !retried) {
    await refresh(env, companyId);
    return pipedriveFetch(env, companyId, apiPath, options, true);
  }
  return res;
}

/** Link a Vobiz account to a connected company (and off any other). */
function link(companyId, authId) {
  if (!getStore().get(companyId)) return false;
  for (const c of companies()) {
    const ids = Array.isArray(c.vobizAuthIds) ? c.vobizAuthIds : [];
    if (c.companyId === companyId && !ids.includes(authId)) getStore().put(companyId, { vobizAuthIds: [...ids, authId] });
    if (c.companyId !== companyId && ids.includes(authId)) getStore().put(c.companyId, { vobizAuthIds: ids.filter((a) => a !== authId) });
  }
  return true;
}

function disconnect(companyId) {
  return getStore().remove(companyId);
}

/** Non-secret view of one company. */
function publicRecord(companyId) {
  const c = companies().find((x) => x.companyId === companyId);
  if (!c) return null;
  return {
    companyId: c.companyId,
    companyDomain: c.companyDomain || null,
    companyName: c.companyName || null,
    apiDomain: c.apiDomain || null,
    scope: c.scope || null,
    vobizAuthIds: c.vobizAuthIds || [],
    accessTokenExpiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    connectedAt: c.connectedAt || null,
  };
}

/** Status for one Vobiz account (the company its calls are logged to). */
function status(authId) {
  const companyId = companyFor(authId);
  if (!companyId) return { connected: false };
  const c = publicRecord(companyId);
  return {
    connected: true,
    companyId: c.companyId,
    companyDomain: c.companyDomain,
    apiDomain: c.apiDomain,
    scope: c.scope,
    linked: isLinked(companyId, authId),
    accessTokenExpiresAt: c.accessTokenExpiresAt,
  };
}

function listCompanies() {
  return companies().map((c) => publicRecord(c.companyId));
}

module.exports = {
  configure, isConfigured, isConnected, anyConnected, companyFor, isLinked,
  buildAuthorizeUrl, consumeState, exchangeCode, refresh, accessToken,
  pipedriveFetch, link, disconnect, status, listCompanies,
};
