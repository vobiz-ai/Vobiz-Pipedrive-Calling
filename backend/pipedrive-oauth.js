/**
 * Pipedrive OAuth 2.0.
 *
 * Marketplace listing requires this. The approval checklist is explicit: "Your
 * app implements and primarily uses OAuth 2.0 for both authentication and
 * request authorization", and "No collection or storage of API tokens". This
 * integration previously used a personal API token exclusively, which cannot be
 * listed no matter how well the rest of it works.
 *
 * Flow:
 *   GET  /auth/pipedrive              -> redirect to Pipedrive's consent screen
 *   GET  /auth/pipedrive/callback     -> exchange ?code for tokens
 *
 * Access tokens last 60 minutes. Refresh tokens expire only if unused for 60
 * days, and each use resets that window. Every API call goes through
 * `pipedriveFetch`, which refreshes on demand and retries once — so a token
 * expiring mid-request is invisible to callers rather than a random 401.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const AUTHORIZE_URL = "https://oauth.pipedrive.com/oauth/authorize";
const TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";

// PIPEDRIVE_TOKEN_STORE moves the file (the test suite uses a temp path).
const TOKEN_STORE = process.env.PIPEDRIVE_TOKEN_STORE || path.join(__dirname, ".pipedrive-tokens.json");

// Outstanding `state` values, so a callback cannot be forged or replayed.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

let tokens = null;   // { access_token, refresh_token, expires_at, api_domain, scope }

function loadTokens() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_STORE, "utf8"));
  } catch {
    tokens = null;
  }
  return tokens;
}

function saveTokens(next) {
  tokens = next;
  try {
    // 0600: this file holds a refresh token, which is a long-lived credential
    // for the customer's entire CRM.
    fs.writeFileSync(TOKEN_STORE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[pipedrive-oauth] Could not persist tokens:", err.message);
  }
}

function isConfigured(env) {
  return Boolean(env.PIPEDRIVE_CLIENT_ID && env.PIPEDRIVE_CLIENT_SECRET && env.PIPEDRIVE_REDIRECT_URI);
}

function isConnected() {
  return Boolean(loadTokens() && loadTokens().refresh_token);
}

function buildAuthorizeUrl(env) {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
  for (const [k, t] of pendingStates) {
    if (Date.now() - t > STATE_TTL_MS) pendingStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id: env.PIPEDRIVE_CLIENT_ID,
    redirect_uri: env.PIPEDRIVE_REDIRECT_URI,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const issued = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - issued <= STATE_TTL_MS;
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

function store(json) {
  saveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token || (tokens && tokens.refresh_token),
    // 30s of headroom, so a call started just before expiry does not race it.
    expires_at: Date.now() + (Number(json.expires_in || 3600) - 30) * 1000,
    api_domain: json.api_domain,
    scope: json.scope,
  });
}

async function exchangeCode(env, code) {
  const json = await postToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.PIPEDRIVE_REDIRECT_URI,
  });
  store(json);
  return tokens;
}

async function refresh(env) {
  const current = loadTokens();
  if (!current || !current.refresh_token) throw new Error("Not connected to Pipedrive");
  const json = await postToken(env, {
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  store(json);
  console.log("[pipedrive-oauth] access token refreshed");
  return tokens;
}

async function accessToken(env) {
  const current = loadTokens();
  if (!current) throw new Error("Not connected to Pipedrive");
  if (!current.expires_at || Date.now() >= current.expires_at) return (await refresh(env)).access_token;
  return current.access_token;
}

/**
 * The one way this integration should talk to Pipedrive.
 *
 * `api_domain` comes from the token response and already encodes the customer's
 * company domain — hardcoding api.pipedrive.com works for some accounts and
 * silently 404s for others.
 */
async function pipedriveFetch(env, apiPath, options = {}, retried = false) {
  const token = await accessToken(env);
  const base = (loadTokens().api_domain || "https://api.pipedrive.com").replace(/\/+$/, "");
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
    await refresh(env);
    return pipedriveFetch(env, apiPath, options, true);
  }
  return res;
}

function disconnect() {
  tokens = null;
  try { fs.unlinkSync(TOKEN_STORE); } catch { /* already gone */ }
}

function status() {
  const t = loadTokens();
  if (!t) return { connected: false };
  return {
    connected: true,
    scope: t.scope || null,
    apiDomain: t.api_domain || null,
    accessTokenExpiresAt: t.expires_at ? new Date(t.expires_at).toISOString() : null,
  };
}

module.exports = {
  isConfigured, isConnected, buildAuthorizeUrl, consumeState,
  exchangeCode, refresh, accessToken, pipedriveFetch, disconnect, status,
};
