const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { resolveStaticFile, contentTypeFor } = require("./static-files");

// Load environment variables from backend/.env, or from VOBIZ_ENV_FILE when set
// (the test suite points this at a throwaway file so it never reads real
// credentials). Variables already in the environment win.
const ENV_FILE = process.env.VOBIZ_ENV_FILE || path.join(__dirname, ".env");
try {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch (e) {
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx !== -1 && !line.trim().startsWith("#")) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (key && process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
}

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");

function getPublicBaseUrl() {
  const configured = process.env.TUNNEL_URL || process.env.PUBLIC_BASE_URL;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  try {
    const urlStr = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    return urlStr || null;
  } catch {
    return null;
  }
}

const cleanEnvVar = (val) => val?.trim().replace(/^["']|["']$/g, "") || "";

const PORT = cleanEnvVar(process.env.PORT) || "8092";
const VOBIZ_API_URL = cleanEnvVar(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai";

const PIPEDRIVE_API_TOKEN = cleanEnvVar(process.env.PIPEDRIVE_API_TOKEN);
const PIPEDRIVE_API_URL = cleanEnvVar(process.env.PIPEDRIVE_API_URL) || "https://api.pipedrive.com/v1";

const crypto = require("crypto");

// ─── recording link signing ─────────────────────────────────────────────────
// A plain <audio> element cannot send an Authorization header, so a playback
// URL has to carry its own proof. It must never carry account credentials:
// these links end up in CRM activity notes, where they are readable by every
// user of the account, indefinitely.
const SIGNING_SECRET = cleanEnvVar(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(cleanEnvVar(process.env.RECORDING_URL_TTL_SECONDS) || 900);

// The Auth ID is part of the signed payload (and of the URL), so a link minted
// for one account can never be replayed to fetch another account's audio.
function signRecordingUrl(authId, recordingId, baseUrl) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(`${authId}|${recordingId}|${exp}`).digest("hex");
  const base = (baseUrl || "").replace(/\/+$/, "");
  return `${base}/recording-file?authId=${encodeURIComponent(authId)}&recordingId=${encodeURIComponent(recordingId)}&exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(authId, recordingId, exp, sig) {
  if (!authId || !exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(`${authId}|${recordingId}|${exp}`).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Hosts this server is willing to fetch call media from. Anything else is
// refused — before the request is made, and again after every redirect.
const MEDIA_HOST_ALLOWLIST = [
  /(^|\.)vobiz\.ai$/i,
  /(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
  /(^|\.)s3\.amazonaws\.com$/i,
];

function describeVobizError(body, status) {
  if (!body || typeof body !== "object") return String(body || `Vobiz returned ${status}`);
  const e = body.error !== undefined ? body.error : body.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const parts = Object.entries(e).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    if (parts.length) return parts.join("; ");
  }
  return `Vobiz returned ${status}`;
}

function isAllowedMediaHost(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return MEDIA_HOST_ALLOWLIST.some((re) => re.test(u.hostname));
}

/**
 * Download a recording's audio by ID with the credentials of the account it
 * belongs to.
 *
 * Credentials come from the in-memory account registry only — never from the
 * query string or request headers — so a caller cannot supply someone else's
 * or steer where they are sent. The media URL comes from the Vobiz API and must be on the
 * host allowlist, before the request and after every redirect; auth headers
 * are dropped on redirects, because a presigned URL carries its own.
 *
 * Returns { buffer, contentType } or { status, error }.
 */
async function fetchRecordingMedia(account, recordingId) {
  if (!account || !account.authToken) {
    // Tokens live in memory only. After a restart, an account nobody has
    // signed into again cannot be read.
    return { status: 409, error: "This server no longer holds credentials for that Vobiz account. Sign in to the softphone again, then reopen the link." };
  }
  const authHeaders = { "X-Auth-ID": account.authId, "X-Auth-Token": account.authToken, Accept: "application/json" };
  const metaRes = await fetch(
    `${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(account.authId)}/Recording/${encodeURIComponent(recordingId)}/`,
    { headers: authHeaders }
  );
  if (!metaRes.ok) return { status: metaRes.status === 404 ? 404 : 502, error: `Vobiz returned ${metaRes.status} for that recording` };
  const meta = await metaRes.json().catch(() => ({}));
  const mediaUrl = meta.recording_url || meta.url;
  if (!mediaUrl) return { status: 404, error: "No audio is available for that recording yet" };
  if (!isAllowedMediaHost(mediaUrl)) {
    console.error(`[recording] refusing off-allowlist media host: ${mediaUrl}`);
    return { status: 502, error: "Recording is hosted somewhere this server will not fetch from" };
  }

  let mediaRes = await fetch(mediaUrl, { headers: authHeaders, redirect: "manual" });
  let hops = 0;
  while (mediaRes.status >= 300 && mediaRes.status < 400 && hops < 3) {
    const location = mediaRes.headers.get("location");
    if (!location) break;
    const next = new URL(location, mediaUrl).toString();
    if (!isAllowedMediaHost(next)) {
      console.error(`[recording] refusing redirect to ${next}`);
      return { status: 502, error: "Recording redirected somewhere this server will not follow" };
    }
    mediaRes = await fetch(next, { redirect: "manual" });
    hops++;
  }
  if (!mediaRes.ok) return { status: 502, error: `Media server returned ${mediaRes.status}` };
  return {
    contentType: mediaRes.headers.get("content-type") || "audio/mpeg",
    buffer: Buffer.from(await mediaRes.arrayBuffer()),
  };
}

// Opt-in mocking. Without this, an unconfigured server reports failure rather
// than inventing CRM records that look real.
const pipedriveOAuth = require("./pipedrive-oauth");

const PIPEDRIVE_OAUTH_ENV = {
  get PIPEDRIVE_CLIENT_ID() { return cleanEnvVar(process.env.PIPEDRIVE_CLIENT_ID); },
  get PIPEDRIVE_CLIENT_SECRET() { return cleanEnvVar(process.env.PIPEDRIVE_CLIENT_SECRET); },
  get PIPEDRIVE_REDIRECT_URI() {
    return cleanEnvVar(process.env.PIPEDRIVE_REDIRECT_URI) ||
      `${(getPublicBaseUrl() || `http://localhost:${PORT}`).replace(/\/+$/, "")}/auth/pipedrive/callback`;
  },
};

const VOBIZ_REGISTRAR = cleanEnvVar(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";
const DATA_DIR = cleanEnvVar(process.env.DATA_DIR) || path.join(__dirname, "data");

const { createAccountRegistry } = require("./vobiz-accounts");
const registry = createAccountRegistry({
  apiUrl: VOBIZ_API_URL,
  dataDir: DATA_DIR,
  publicBaseUrl: () => getPublicBaseUrl() || "",
});

// token -> { agentId, authId, sipUser, sipPassword, numbers, from, createdAt }.
// The Vobiz Auth Token is never stored per-session and never returned to the
// browser; it lives once, in memory, in the account registry.
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getSession(req) {
  const header = (req.headers && req.headers.authorization) || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return s;
}

/**
 * Gate for every route that spends money, reads CRM data, or reads call
 * recordings. Writes a 401 and returns null when there is no valid session.
 */
function requireSession(req, res) {
  const s = getSession(req);
  if (!s) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Sign in first" }));
    return null;
  }
  return s;
}

const { makeVerifier } = require("./vobiz-signature");
const verifyVobizWebhook = makeVerifier({
  mode: cleanEnvVar(process.env.VOBIZ_WEBHOOK_SIGNATURES) || "verify",
  publicBaseUrl: () => getPublicBaseUrl() || "",
});

/**
 * Which account a webhook belongs to: the call this server already routed,
 * else the SIP user it came from, else the number that was dialled.
 */
function accountForWebhook(params) {
  const callUuid = String(params.CallUUID || params.call_uuid || "");
  const known = callUuid && (activeCalls.get(callUuid) || callRecordings.get(callUuid));
  if (known && known.authId) return registry.get(known.authId);
  const from = String(params.From || params.from || "");
  const viaSip = registry.bySipUser(registry.sipUserFrom(from));
  if (viaSip) return viaSip.account;
  // Vobiz names the account on inbound webhooks.
  const parent = registry.get(String(params.ParentAuthID || params.parentauthid || ""));
  if (parent) return parent;
  return registry.byNumber(params.To || params.to) || registry.byNumber(from) || null;
}

/** Is this webhook for a SIP-direct agent (no account credentials held)? */
function isSipDirectWebhook(params) {
  const callUuid = String(params.CallUUID || params.call_uuid || "");
  const known = callUuid && (activeCalls.get(callUuid) || callRecordings.get(callUuid));
  if (known) return Boolean(known.sipDirect);
  const from = String(params.From || params.from || "");
  if (registry.sipDirectFor(registry.sipUserFrom(from))) return true;
  return registry.sipDirectByNumber(params.To || params.to).length > 0;
}

/**
 * Writes a 403 and returns true when a Vobiz webhook fails verification. The
 * key is the owning account's Auth Token; for a callback no signed-in account
 * claims, every known account's token is tried.
 */
function rejectUnverifiedWebhook(req, res, pathname, params) {
  const owner = accountForWebhook(params || {});
  const tokens = owner ? [owner.authToken] : registry.all().map((a) => a.authToken);
  const noKey = !owner && isSipDirectWebhook(params || {});
  if (verifyVobizWebhook(req, pathname, tokens, { noKey })) return false;
  res.writeHead(403, { "Content-Type": "text/plain" });
  res.end("invalid signature");
  return true;
}

const PIPEDRIVE_ALLOW_API_TOKEN = /^(1|true|yes)$/i.test(cleanEnvVar(process.env.PIPEDRIVE_ALLOW_API_TOKEN));

const ALLOW_MOCK = /^(1|true|yes)$/i.test(cleanEnvVar(process.env.ALLOW_MOCK));

// Agent profiles: backend/agents.json (see agents.example.json), or the file
// AGENTS_FILE names. Read on each use so edits apply without a restart.
const AGENTS_FILE = cleanEnvVar(process.env.AGENTS_FILE) || path.join(__dirname, "agents.json");
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function loadAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
      if (agents && typeof agents === "object" && !Array.isArray(agents)) return agents;
    }
  } catch (err) {
    console.error("[backend] Error reading agents.json:", err.message);
  }
  return {};
}

/**
 * The profile for an agent id. An id with no entry in agents.json is still a
 * valid profile: it is named after itself and owns nothing in Pipedrive.
 */
function getAgent(agentId) {
  const entry = loadAgents()[agentId];
  const a = entry && typeof entry === "object" ? entry : {};
  const uid = Number(a.pipedriveUserId);
  return {
    id: agentId,
    name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : agentId,
    pipedriveEmail: typeof a.pipedriveEmail === "string" ? a.pipedriveEmail : "",
    pipedriveUserId: Number.isInteger(uid) && uid > 0 ? uid : null,
  };
}

/** Ids and display names only: this list is served without sign-in. */
function listAgentProfiles() {
  return Object.keys(loadAgents())
    .filter((id) => AGENT_ID_RE.test(id))
    .map((id) => ({ id, name: getAgent(id).name }));
}

// Global active call tracking map: request_uuid / call_id -> call details
const activeCalls = new Map();
// Cache of completed call recordings and CDRs
const callRecordings = new Map();

/**
 * The answer URL, for both directions.
 *
 * THE BROWSER IS THE A LEG. The softphone sends the SIP INVITE itself and this
 * returns <Dial><Number> to reach the customer.
 *
 * What was here before dialled the customer over the REST API and then bridged
 * the agent in with <Dial><User>. That cannot work: routing *into* a registered
 * WebRTC endpoint is blocked platform-side — Vobiz builds a gateway URI it
 * cannot parse and drops its own INVITE ("tr_eval_uri(): invalid uri",
 * "blocking gw"), 510 times in 14 days including from its own SDK. The customer
 * answers, hears ringback, then "the agent could not be reached".
 *
 * Which direction this is, is decided by who the call is from.
 */
function vobizAnswerXml(params, publicBaseUrl, sipUsers, callerId) {
  const base = (publicBaseUrl || "").replace(/\/+$/, "");

  // action + redirect="false" are both required. Without them Vobiz re-fetches
  // this URL when <Dial> ends and re-executes the whole document, so one call
  // dials the customer over and over.
  const dialAttrs =
    `callerId="${escapeXmlAttr(callerId)}" timeout="30" timeLimit="14400" ` +
    `action="${base}/dial-status" method="POST" redirect="false"`;

  // Self-closing <Record> as a SIBLING BEFORE <Dial>, never nested inside it —
  // FreeSWITCH rejects the nested form and the caller hears a bogus "Busy".
  // recordSession="true" captures the bridged audio; callbackUrl fires when the
  // file is actually downloadable, which beats polling after the call ends.
  const record =
    `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" ` +
    `redirect="false" callbackUrl="${base}/recording-callback" callbackMethod="POST"/>`;

  const from = String(params.From || params.from || "");
  const to = String(params.To || params.to || "");
  const routeType = String(params.RouteType || params.routetype || "").toLowerCase();
  const fromBrowser = from.startsWith("sip:") || routeType === "sip";

  if (fromBrowser) {
    const destination = to.replace(/[^\d+]/g, "");
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${record}
  <Dial ${dialAttrs}>
    <Number>${escapeXmlText(destination)}</Number>
  </Dial>
</Response>`;
  }

  // Inbound PSTN. <Dial><User> is the only way to reach a registered endpoint.
  // Every signed-in agent of the account rings at once; the first to answer
  // is bridged.
  const users = (Array.isArray(sipUsers) ? sipUsers : [sipUsers]).filter(Boolean)
    .map((u) => `    <User>sip:${escapeXmlText(String(u).replace(/^sip:/, ""))}</User>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${record}
  <Dial ${dialAttrs}>
${users}
  </Dial>
</Response>`;
}

/** A call no signed-in account claims: say so and hang up. */
function politeHangupXml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${escapeXmlText(message)}</Speak>
  <Hangup/>
</Response>`;
}

const escapeXmlText = (v) =>
  String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeXmlAttr = (v) => escapeXmlText(v).replace(/"/g, "&quot;");

// Origins allowed to drive this backend. A wildcard — what this used to send —
// lets any page on the internet place calls billed to the account and read the
// CRM data this server exposes.
//
// Pipedrive iframes app extensions from the customer's own *.pipedrive.com
// origin; ALLOWED_ORIGINS adds anything else you host the softphone on.
const ORIGIN_ALLOWLIST = [
  /^https:\/\/[a-z0-9-]+\.pipedrive\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];
const EXTRA_ORIGINS = cleanEnvVar(process.env.ALLOWED_ORIGINS)
  .split(",").map((o) => o.trim()).filter(Boolean);

function withCors(res, req) {
  const origin = req && req.headers && req.headers.origin;
  if (origin && (EXTRA_ORIGINS.includes(origin) || ORIGIN_ALLOWLIST.some((re) => re.test(origin)))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

/**
 * Vobiz posts its webhooks as application/x-www-form-urlencoded, not JSON.
 * Parsing those with a JSON reader yields {} and every parameter reads as
 * undefined — which looks exactly like Vobiz sending nothing.
 */
function readFormOrJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw.trim();
      if (!body) return resolve({});
      if (body.startsWith("{") || body.startsWith("[")) {
        try { return resolve(JSON.parse(body)); } catch { /* fall through */ }
      }
      resolve(Object.fromEntries(new URLSearchParams(body)));
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
        return;
      } catch {
        // Fallback to form-urlencoded parsing
      }
      try {
        const parsed = Object.fromEntries(new URLSearchParams(raw));
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function formatDuration(seconds) {
  const sec = parseInt(seconds || 0, 10);
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Pipedrive activity `duration` is HH:MM. Sending MM:SS — what this used to
 * do — logged a 42-second call as 42 minutes. Rounded up so a short call is
 * never shown as zero.
 */
function pipedriveActivityDuration(seconds) {
  const sec = Math.max(0, parseInt(seconds || 0, 10) || 0);
  const totalMinutes = Math.ceil(sec / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
}

/** "YYYY-MM-DD HH:MM:SS" in UTC, the format /callLogs requires. */
function pipedriveUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const escapeHtml = (v) => escapeXmlAttr(v).replace(/'/g, "&#39;");

// ==========================================
// Pipedrive API Integration Helpers
// ==========================================

/**
 * Every Pipedrive request goes through here.
 *
 * OAuth is the path that matters: Marketplace requires it and forbids storing
 * API tokens. The personal-API-token path is kept only so existing internal
 * installs keep working, it must be turned on deliberately with
 * PIPEDRIVE_ALLOW_API_TOKEN=1, and it says loudly that it cannot be listed.
 */
let warnedAboutApiToken = false;

/**
 * Is Pipedrive reachable by any supported means?
 *
 * Keying the guards off PIPEDRIVE_API_TOKEN alone meant a fully OAuth-connected
 * server still reported "not configured" and skipped every CRM write — the
 * token is exactly what OAuth replaces.
 */
function pipedriveAvailable() {
  return pipedriveOAuth.isConnected() ||
    Boolean(PIPEDRIVE_API_TOKEN && !PIPEDRIVE_API_TOKEN.includes("YOUR_PIPEDRIVE") && PIPEDRIVE_ALLOW_API_TOKEN);
}

async function pipedriveRequest(apiPath, options = {}) {
  if (pipedriveOAuth.isConnected()) {
    return pipedriveOAuth.pipedriveFetch(PIPEDRIVE_OAUTH_ENV, `/api/v1${apiPath}`, options);
  }

  if (PIPEDRIVE_API_TOKEN && PIPEDRIVE_ALLOW_API_TOKEN) {
    if (!warnedAboutApiToken) {
      console.warn("[Pipedrive] Using a personal API token. This cannot be published on the Pipedrive Marketplace — connect via /auth/pipedrive instead.");
      warnedAboutApiToken = true;
    }
    const sep = apiPath.includes("?") ? "&" : "?";
    return fetch(`${PIPEDRIVE_API_URL}${apiPath}${sep}api_token=${PIPEDRIVE_API_TOKEN}`, options);
  }

  const err = new Error(
    pipedriveOAuth.isConfigured(PIPEDRIVE_OAUTH_ENV)
      ? "Not connected to Pipedrive. Visit /auth/pipedrive to authorise."
      : "Pipedrive is not configured. Set the OAuth client credentials, or PIPEDRIVE_ALLOW_API_TOKEN=1 to use a personal token."
  );
  err.notConfigured = true;
  throw err;
}

/**
 * The person's open deal, when there is exactly one. With none or several
 * there is no way to tell which deal the call is about, so it is not linked.
 */
async function openDealFor(personId) {
  if (!personId) return { deal_id: null };
  try {
    const res = await pipedriveRequest(`/persons/${encodeURIComponent(personId)}/deals?status=open&limit=2`);
    const json = await res.json().catch(() => ({}));
    const deals = res.ok && json.success && Array.isArray(json.data) ? json.data : [];
    if (deals.length === 1 && deals[0] && deals[0].id) {
      return { deal_id: deals[0].id, deal_title: deals[0].title || null };
    }
  } catch (err) {
    console.error("[Pipedrive] Error looking up the person's open deals:", err.message);
  }
  return { deal_id: null };
}

async function getPipedrivePersonByPhone(phoneNumber) {
  if (!pipedriveAvailable()) {
    // Mock data is opt-in. It used to be the silent fallback whenever the token
    // was missing, so the whole test suite passed green against a CRM it had
    // never contacted.
    if (!ALLOW_MOCK) {
      console.error("[Pipedrive] No API token configured and ALLOW_MOCK is not set — refusing to invent a contact.");
      return { mocked: false, pipedriveConfigured: false, error: "Pipedrive is not configured on this server", person_id: null, name: null };
    }
    console.warn("[Pipedrive] MOCK MODE — returning a fabricated person match. Not real CRM data.");
    return {
      mocked: true,
      person_id: 101,
      name: "Sample Pipedrive Contact (MOCK)",
      email: "contact@example.com",
      deal_id: 201,
      deal_title: "Vobiz Enterprise Expansion Deal"
    };
  }

  try {
    const cleanPhone = (phoneNumber || "").replace(/[^0-9+]/g, "");
    const searchUrl = `/persons/find?term=${encodeURIComponent(cleanPhone)}&search_by_phone=1`;
    const res = await pipedriveRequest(searchUrl);
    const json = await res.json();
    
    if (json.success && Array.isArray(json.data) && json.data.length > 0) {
      const match = json.data[0];
      return {
        person_id: match.id,
        name: match.name,
        email: match.email,
        phone: match.phone,
        organization: match.org_name || null,
        ...(await openDealFor(match.id))
      };
    }

    // Try itemSearch if find didn't return matches
    const itemSearchUrl = `/itemSearch?term=${encodeURIComponent(cleanPhone)}&item_types=person&fields=phone`;
    const searchRes = await pipedriveRequest(itemSearchUrl);
    const searchJson = await searchRes.json();
    if (searchJson.success && searchJson.data?.items?.length > 0) {
      const item = searchJson.data.items[0].item;
      return {
        person_id: item.id,
        name: item.name,
        email: item.emails?.[0] || null,
        phone: item.phones?.[0] || null,
        organization: item.organization?.name || null,
        ...(await openDealFor(item.id))
      };
    }
  } catch (err) {
    console.error("[Pipedrive] Error looking up Person by phone:", err.message);
  }

  return {
    person_id: null,
    name: "Unknown Contact",
    deal_id: null
  };
}

async function createPipedriveActivity(callInfo) {
  if (!pipedriveAvailable()) {
    if (!ALLOW_MOCK) {
      console.error("[Pipedrive] No API token configured and ALLOW_MOCK is not set — activity NOT created.");
      return { mocked: false, success: false, pipedriveConfigured: false, error: "Pipedrive is not configured on this server" };
    }
    console.warn("[Pipedrive] MOCK MODE — no activity was created in any CRM.");
    return {
      mocked: true,
      success: true,
      data: {
        id: Math.floor(Math.random() * 900000) + 100000,
        subject: `Vobiz ${callInfo.direction} Call - ${callInfo.targetNumber}`,
        done: true,
        type: "call",
        duration: callInfo.duration
      }
    };
  }

  try {
    const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
    // Signed, expiring, and keyed by recording ID — never the media URL, and
    // never carrying credentials. This link is written into a CRM note, where
    // everyone on the account can read it for as long as the record exists.
    const proxyRecordingUrl = callInfo.recordingId && callInfo.authId
      ? signRecordingUrl(callInfo.authId, callInfo.recordingId, publicBaseUrl)
      : null;

    const formattedDuration = formatDuration(callInfo.duration);

    // Every value here can come from a webhook, so all of it is escaped
    // before it goes into HTML that Pipedrive renders.
    const e = escapeHtml;
    const noteHtml = `
<h3>Vobiz call log</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-family: sans-serif; font-size: 13px;">
  <tr><td><b>Call UUID</b></td><td><code>${e(callInfo.callUuid || "N/A")}</code></td></tr>
  <tr><td><b>Direction</b></td><td>${e(callInfo.direction)}</td></tr>
  <tr><td><b>From</b></td><td>${e(callInfo.from)}</td></tr>
  <tr><td><b>To</b></td><td>${e(callInfo.to)}</td></tr>
  <tr><td><b>Agent</b></td><td>${e(callInfo.agentName || "")}</td></tr>
  <tr><td><b>Duration</b></td><td>${e(formattedDuration)} (${e(callInfo.duration || 0)}s)</td></tr>
  <tr><td><b>Hangup cause</b></td><td><code>${e(callInfo.hangupCause || "")}</code></td></tr>
</table>
${proxyRecordingUrl ? `<p><b>Recording:</b> <a href="${e(proxyRecordingUrl)}" target="_blank" rel="noopener">Listen</a> (link expires; re-open it from the softphone's recordings list)</p>` : "<p><i>No recording for this call.</i></p>"}
`;

    const body = {
      subject: `Vobiz ${callInfo.direction} call - ${callInfo.targetNumber || ""}`.trim(),
      type: "call",
      done: 1,
      duration: pipedriveActivityDuration(callInfo.duration),
      note: noteHtml,
      person_id: callInfo.personId || undefined,
      deal_id: callInfo.dealId || undefined,
      // The agent's Pipedrive user, from agents.json. Absent: the connected
      // (authorising) user owns it, as before.
      user_id: callInfo.pipedriveUserId || undefined
    };

    const res = await pipedriveRequest("/activities", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });

    const json = await res.json();
    if (!res.ok || !json.success) {
      console.error("[Pipedrive] Activity creation failed:", res.status, json);
      return { success: false, error: json };
    }

    console.log(`[Pipedrive] Successfully created Activity ID #${json.data.id} for ${callInfo.direction} call`);
    return json;
  } catch (err) {
    console.error("[Pipedrive] Network error creating activity:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * POST /callLogs. Pipedrive requires `outcome`, `to_phone_number`,
 * `start_time` and `end_time`. This used to send `to_call_number`,
 * `phone_number`, `recording_url` and no end time, so every request was
 * rejected with a 400 that nothing checked — no Call Log was ever written.
 * The recording link goes in the note: Pipedrive only takes recordings as a
 * file upload to /callLogs/{id}/recordings.
 */
function buildCallLogBody(callInfo, recordingLink) {
  const durationSec = Math.max(0, parseInt(callInfo.duration || 0, 10) || 0);
  const end = callInfo.endTime || Date.now();
  const start = callInfo.startTime || (end - durationSec * 1000);
  const answered = durationSec > 0 || /^(completed|answer)/i.test(String(callInfo.dialStatus || ""));
  return {
    subject: `Vobiz ${callInfo.direction} call`,
    outcome: answered ? "connected" : (/busy/i.test(String(callInfo.hangupCause || "")) ? "busy" : "no_answer"),
    from_phone_number: callInfo.from || undefined,
    to_phone_number: callInfo.to || callInfo.targetNumber,
    start_time: pipedriveUtc(start),
    end_time: pipedriveUtc(Math.max(end, start)),
    duration: String(durationSec),
    person_id: callInfo.personId || undefined,
    deal_id: callInfo.dealId || undefined,
    user_id: callInfo.pipedriveUserId || undefined,
    note: recordingLink ? `<p>Recording: <a href="${escapeHtml(recordingLink)}">Listen</a></p>` : undefined,
  };
}

/**
 * Attach the audio to the Call Log, so it plays inside Pipedrive for as long
 * as the record exists. The signed link in the note expires (it has to: it
 * is readable by everyone on the CRM account), so this is the durable copy.
 */
async function uploadCallLogRecording(callLogId, authId, recordingId) {
  try {
    const media = await fetchRecordingMedia(registry.get(authId), recordingId);
    if (media.error) {
      console.warn(`[Pipedrive] recording ${recordingId} not attached: ${media.error}`);
      return { success: false, error: media.error };
    }
    const ext = /wav/i.test(media.contentType) ? "wav" : "mp3";
    const form = new FormData();
    form.append("file", new Blob([media.buffer], { type: media.contentType }), `${recordingId}.${ext}`);
    const res = await pipedriveRequest(`/callLogs/${encodeURIComponent(callLogId)}/recordings`, { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      console.warn(`[Pipedrive] recording upload failed: HTTP ${res.status}`, json.error || "");
      return { success: false, status: res.status, error: json.error || `HTTP ${res.status}` };
    }
    console.log(`[Pipedrive] Attached recording to Call Log ${callLogId}`);
    return { success: true };
  } catch (err) {
    console.warn("[Pipedrive] recording upload error:", err.message);
    return { success: false, error: err.message };
  }
}

async function createPipedriveCallLog(callInfo) {
  if (!pipedriveAvailable()) {
    return { success: false, pipedriveConfigured: false, error: "Pipedrive is not configured on this server" };
  }

  try {
    const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
    const proxyRecordingUrl = callInfo.recordingId && callInfo.authId
      ? signRecordingUrl(callInfo.authId, callInfo.recordingId, publicBaseUrl)
      : null;

    const body = buildCallLogBody(callInfo, proxyRecordingUrl);
    if (!body.to_phone_number) {
      return { success: false, error: "No destination number for this call; call log not written" };
    }

    const res = await pipedriveRequest("/callLogs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      console.error("[Pipedrive] Call Log creation failed:", res.status, json.error || json);
      return { success: false, status: res.status, error: json.error || `HTTP ${res.status}` };
    }
    const callLogId = json.data && json.data.id;
    console.log(`[Pipedrive] Created Call Log ${callLogId}`);
    if (callLogId && callInfo.recordingId) {
      json.recordingUpload = await uploadCallLogRecording(callLogId, callInfo.authId, callInfo.recordingId);
    }
    return json;
  } catch (err) {
    console.error("[Pipedrive] Call Log creation error:", err.message);
    return { success: false, error: err.message };
  }
}

// ==========================================
// HTTP Server & Route Handler
// ==========================================

const server = http.createServer(async (req, res) => {
  withCors(res, req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(`[backend] ${req.method} ${pathname}`);

  // 1. Health check
  if (pathname === "/health" || pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Booleans only. This used to print the first characters of the Auth ID
    // and the Pipedrive token to anyone who asked.
    res.end(JSON.stringify({
      status: "ok",
      service: "vobiz-pipedrive-integration",
      pipedriveConnected: pipedriveAvailable(),
      publicUrlConfigured: Boolean(getPublicBaseUrl()),
    }));
    return;
  }

  // Agent profiles for the sign-in picker: ids and display names from
  // agents.json, nothing else (no emails, SIP users or Pipedrive ids), so it
  // needs no session.
  if (pathname === "/api/agents" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ agents: listAgentProfiles() }));
    return;
  }

  // ── Pipedrive OAuth 2.0 ───────────────────────────────────────────────────
  // Required for Marketplace listing: Pipedrive mandates OAuth 2.0 and forbids
  // collecting or storing API tokens.
  if (pathname === "/auth/pipedrive" && req.method === "GET") {
    if (!pipedriveOAuth.isConfigured(PIPEDRIVE_OAUTH_ENV)) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Pipedrive OAuth is not configured. Set PIPEDRIVE_CLIENT_ID, PIPEDRIVE_CLIENT_SECRET and PIPEDRIVE_REDIRECT_URI.",
      }));
      return;
    }
    // Once connected, re-authorising needs a signed-in agent to disconnect
    // first. Otherwise anyone who can reach this URL could swap in their own
    // Pipedrive company and receive this account's call logs.
    if (pipedriveOAuth.isConnected()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Already connected to Pipedrive. Sign in to the softphone and disconnect first to connect a different company." }));
      return;
    }
    const target = pipedriveOAuth.buildAuthorizeUrl(PIPEDRIVE_OAUTH_ENV);
    console.log("[oauth] redirecting to Pipedrive consent screen");
    res.writeHead(302, { Location: target });
    res.end();
    return;
  }

  if (pathname === "/auth/pipedrive/callback" && req.method === "GET") {
    const { code, state, error } = parsedUrl.query;
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (error) {
      res.writeHead(400);
      res.end(`<h1>Pipedrive authorisation failed</h1><p>${escapeXmlText(error)}</p>`);
      return;
    }
    // An unrecognised or stale `state` means this callback did not originate
    // from a flow we started.
    if (!pipedriveOAuth.consumeState(state)) {
      console.error("[oauth] callback with unknown or expired state — rejected");
      res.writeHead(400);
      res.end("<h1>Authorisation rejected</h1><p>This callback did not match a sign-in this server started. Start again from /auth/pipedrive.</p>");
      return;
    }
    if (!code) {
      res.writeHead(400);
      res.end("<h1>Authorisation failed</h1><p>Pipedrive returned no authorization code.</p>");
      return;
    }
    try {
      await pipedriveOAuth.exchangeCode(PIPEDRIVE_OAUTH_ENV, code);
      console.log("[oauth] connected to Pipedrive");
      res.writeHead(200);
      res.end("<h1>Connected to Pipedrive</h1><p>You can close this tab and return to the softphone.</p>");
    } catch (err) {
      console.error("[oauth] token exchange failed:", err.message);
      res.writeHead(502);
      res.end(`<h1>Token exchange failed</h1><p>${escapeXmlText(err.message)}</p>`);
    }
    return;
  }

  if (pathname === "/auth/pipedrive/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      configured: pipedriveOAuth.isConfigured(PIPEDRIVE_OAUTH_ENV),
      ...pipedriveOAuth.status(),
    }));
    return;
  }

  if (pathname === "/auth/pipedrive/disconnect" && req.method === "POST") {
    if (!getSession(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sign in first" }));
      return;
    }
    pipedriveOAuth.disconnect();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Sign-in. Any Vobiz account: the pair is checked against Vobiz itself
  // (GET /numbers — only a 2xx counts), then this integration's Application
  // and the agent's own SIP endpoint are found or created in THAT account.
  // The browser gets an opaque session token and a fresh SIP password for its
  // endpoint; never the Auth Token.
  if ((pathname === "/api/login" || pathname === "/login") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const authId = String(body.authId || "").trim();
      const authToken = String(body.authToken || "").trim();
      const agentId = typeof body.agentId === "string" && AGENT_ID_RE.test(body.agentId.trim()) ? body.agentId.trim() : "admin";

      if (!authId || !authToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Both Vobiz Auth ID and Auth Token are required." }));
        return;
      }
      if (!/^[A-Za-z0-9_]{4,64}$/.test(authId)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "That does not look like a Vobiz Auth ID (e.g. MA_XXXXXXXX)." }));
        return;
      }

      const result = await registry.signIn(authId, authToken, agentId);
      if (!result.ok) {
        console.log(`[/api/login] sign-in refused for ${authId.slice(0, 12)} (${result.status})`);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: result.error }));
        return;
      }

      const agent = getAgent(agentId);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, {
        agentId,
        authId,
        sipUser: result.sip.username,
        sipPassword: result.sip.password,
        numbers: result.numbers,
        from: result.callerId,
        createdAt: Date.now(),
      });

      console.log(`[/api/login] ${agentId} signed in to ${authId} as SIP user ${result.sip.username}`);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        success: true,
        message: "Signed in to Vobiz.",
        token,
        authId,
        numbers: result.numbers,
        // application_id per number, so "Enable inbound calls" can say which
        // application the number is moving from.
        numberDetails: result.numberDetails,
        applicationId: result.account.appId,
        selected: result.callerId,
        agent: { id: agentId, name: agent.name, email: agent.pipedriveEmail },
      }));
    } catch (err) {
      console.error("[/api/login] Exception:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Sign-in failed" }));
    }
    return;
  }

  // SIP direct: the agent typed an existing endpoint's SIP username and
  // password (the password stays in the browser) plus a caller ID. The
  // backend only records sipUser -> caller ID / inbound number so it can route
  // that endpoint's webhooks. No session is issued: SIP direct has no account
  // API access (recordings, numbers, CRM lookups need an account sign-in).
  if (pathname === "/api/sip-direct" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const r = registry.claimSipDirect(body.sipUser, body.callerId);
    res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(r.ok
      ? { success: true, claimToken: r.claimToken, callerId: r.callerId }
      : { success: false, error: r.error }));
    if (r.ok) console.log(`[sip-direct] ${String(body.sipUser)} will call out as ${r.callerId}`);
    return;
  }

  if (pathname === "/api/sip-direct/release" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const ok = registry.releaseSipDirect(body.sipUser, body.claimToken);
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: ok }));
    return;
  }

  // Caller ID for outbound calls. Must be a number on the signed-in account.
  if (pathname === "/api/caller-id" && req.method === "POST") {
    const session = requireSession(req, res);
    if (!session) return;
    const body = await readJsonBody(req).catch(() => ({}));
    if (!registry.setCallerId(session.sipUser, body.number)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "That number is not on this Vobiz account" }));
      return;
    }
    session.from = registry.normalizeE164(body.number);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, selected: session.from }));
    return;
  }

  // "Enable inbound calls": attach one of the account's numbers to this
  // integration's application. Explicit only — it moves the number off
  // whatever application it was on before.
  if (pathname === "/api/inbound/enable" && req.method === "POST") {
    const session = requireSession(req, res);
    if (!session) return;
    const body = await readJsonBody(req).catch(() => ({}));
    try {
      const r = await registry.enableInbound(session.authId, body.number || session.from);
      res.writeHead(r.ok ? 200 : r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.ok
        ? { success: true, number: r.number, applicationId: r.applicationId, previousApplicationId: r.previousApplicationId }
        : { success: false, error: r.error }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Session query endpoint. Bearer token only: the old /session/<agentId>
  // variant told anyone who asked whether an agent was signed in, and as
  // which Auth ID with which numbers.
  if ((pathname === "/session" || pathname === "/api/session") && req.method === "GET") {
    const s = getSession(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(s
      ? { loggedIn: true, agentId: s.agentId, authId: s.authId, numbers: s.numbers || [], from: s.from || "" }
      : { loggedIn: false }));
    return;
  }

  // Session logout endpoint
  if ((pathname === "/logout" || pathname === "/api/logout") && req.method === "POST") {
    const header = (req.headers && req.headers.authorization) || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const s = token ? sessions.get(token) : null;
    if (token) sessions.delete(token);
    // Stop routing inbound calls to an endpoint nobody is signed in on.
    if (s && ![...sessions.values()].some((o) => o.sipUser === s.sipUser)) registry.forgetSipUser(s.sipUser);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, success: true }));
    return;
  }

  // Recent recordings, each with a signed, short-lived playback link.
  // Behind the session: the signed links ARE the access control for the audio,
  // so handing them to anyone who asked made the signature pointless.
  if ((pathname === "/recordings" || pathname === "/api/recordings") && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
      const limit = Math.min(Math.max(Number(parsedUrl.query.limit) || 15, 1), 50);
      const account = registry.get(session.authId);
      let recordings = [];
      if (account) {
        try {
          const r = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(account.authId)}/Recording/?limit=${limit}`, {
            headers: { "X-Auth-ID": account.authId, "X-Auth-Token": account.authToken, Accept: "application/json" }
          });
          if (r.ok) {
            const data = await r.json();
            const objects = data.objects || data.items || [];
            recordings = objects.filter((o) => o.recording_id).map((o) => ({
              recording_id: o.recording_id,
              add_time: o.add_time,
              rounded_recording_duration: o.rounded_recording_duration,
              call_uuid: o.call_uuid,
              playUrl: signRecordingUrl(account.authId, o.recording_id, publicBaseUrl),
            }));
          }
        } catch (e) {
          console.warn("[/recordings] Vobiz API fetch notice:", e.message);
        }
      }
      if (recordings.length === 0 && callRecordings.size > 0) {
        recordings = Array.from(callRecordings.values()).filter((c) => c.recordingId && c.authId === session.authId).map((c) => ({
          recording_id: c.recordingId,
          add_time: new Date(c.startTime || Date.now()).toISOString(),
          rounded_recording_duration: c.duration || 0,
          call_uuid: c.callUuid,
          playUrl: signRecordingUrl(c.authId, c.recordingId, publicBaseUrl),
        }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recordings, objects: recordings }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recordings: [], error: err.message }));
    }
    return;
  }

  // Signed playback link for a call this server has seen.
  if (pathname === "/play-recording" && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    const callUuid = parsedUrl.query.callUuid;
    const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
    const rec = callUuid ? (callRecordings.get(callUuid) || activeCalls.get(callUuid)) : null;
    if (rec && rec.recordingId && rec.authId === session.authId) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playUrl: signRecordingUrl(rec.authId, rec.recordingId, publicBaseUrl) }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Recording not found for this call" }));
    return;
  }

  // SIP credentials for the softphone to register with: this session's own
  // endpoint, with the password set at sign-in. Held in memory for this
  // session only; a new sign-in rotates it.
  if (pathname === "/api/agent-sip" && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    const agent = getAgent(session.agentId);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      displayName: agent.name,
      sipUser: `${session.sipUser}@${VOBIZ_REGISTRAR}`,
      sipPassword: session.sipPassword,
      registrarUrl: `wss://${VOBIZ_REGISTRAR}:5063/`,
    }));
    return;
  }

  // The account's numbers, for the caller-ID picker.
  if ((pathname === "/numbers" || pathname === "/api/numbers") && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    const numbers = await registry.refreshNumbers(session.authId);
    session.numbers = numbers;
    const account = registry.get(session.authId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ numbers, numberDetails: (account && account.numberDetails) || [], count: numbers.length }));
    return;
  }

  // REST origination is gone. It dialled the customer with POST /Call/ and
  // then bridged the agent with <Dial><User>, which Vobiz blocks (see
  // vobizAnswerXml) — and it was unauthenticated, so anyone could place calls
  // billed to this account. Outbound calls start in the browser: ua.call().
  if (pathname === "/start-call" || pathname === "/transfer-call") {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: pathname === "/start-call"
        ? "Outbound calls are placed from the softphone over SIP (the browser is the A leg). This endpoint was removed."
        : "Call transfer is not supported by this integration.",
    }));
    return;
  }

  // 3. Answer & Fallback. Multi-tenant: the account is found from the SIP user
  // the browser registered as (outbound) or from the number that was dialled
  // (inbound). Nothing here falls back to a server-wide account.
  if ((pathname === "/answer" || pathname === "/fallback") && (req.method === "POST" || req.method === "GET")) {
    const body = req.method === "POST" ? await readFormOrJsonBody(req) : {};
    const params = { ...parsedUrl.query, ...body };
    if (rejectUnverifiedWebhook(req, res, pathname, params)) return;
    try {
      const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;

      res.writeHead(200, { "Content-Type": "application/xml" });

      // A Hangup notification is not a request for instructions. Returning
      // <Dial> here hands Vobiz a fresh call leg after the call already ended.
      if ((params.Event || params.event) === "Hangup") {
        console.log(`[/answer] Hangup notification for ${params.CallUUID || "?"} — returning empty response`);
        res.end('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
        return;
      }

      const from = String(params.From || params.from || "");
      const to = String(params.To || params.to || "");
      const routeType = String(params.RouteType || params.routetype || "").toLowerCase();
      const fromBrowser = from.startsWith("sip:") || routeType === "sip";
      const callUuid = params.CallUUID || params.call_uuid || "";

      let authId, agentId, callerId, sipTargets = [], sipDirect = false;
      const headerCallerId = registry.normalizeE164(
        params["X-VH-Caller-ID"] || params["SIPHeader_X-VH-Caller-ID"] || params["X-PH-Caller-ID"] || ""
      );
      if (fromBrowser && registry.sipDirectFor(registry.sipUserFrom(from))) {
        // Outbound from a SIP-direct agent: the caller ID it registered, or a
        // strictly E.164 X-VH-Caller-ID header. Vobiz refuses a number the
        // account does not own.
        const direct = registry.sipDirectFor(registry.sipUserFrom(from));
        sipDirect = true;
        authId = String(params.ParentAuthID || params.parentauthid || "");
        agentId = "admin";
        callerId = registry.isE164(headerCallerId) ? headerCallerId : direct.callerId;
      } else if (fromBrowser) {
        // Outbound: the browser is the A leg.
        const who = registry.bySipUser(registry.sipUserFrom(from));
        if (!who) {
          console.warn(`[/answer] outbound from unknown SIP user ${registry.sipUserFrom(from) || from || "?"} — no signed-in account; hanging up`);
          res.end(politeHangupXml("This phone is not signed in. Please sign in to the softphone and try again."));
          return;
        }
        authId = who.authId;
        agentId = who.agentId;
        // The picked caller ID travels as an X-VH-Caller-ID SIP header and is
        // also set out of band (/api/caller-id). Either is used only when it
        // is one of this account's numbers.
        callerId = who.account.numbers.includes(headerCallerId)
          ? headerCallerId
          : (who.account.numbers.includes(who.callerId) ? who.callerId : who.account.numbers[0] || "");
        if (!callerId) {
          console.warn(`[/answer] ${authId} has no numbers to use as caller ID; hanging up`);
          res.end(politeHangupXml("This Vobiz account has no phone number to call from."));
          return;
        }
      } else {
        // Inbound PSTN: whichever signed-in account owns the dialled DID.
        // callerId is mandatory and must be that DID in E.164. Omit it and
        // Vobiz derives it from the A leg — the caller's number, which the
        // account does not own — and silently refuses to create the B leg.
        //
        // The account is the webhook's ParentAuthID; the dialled To -> account
        // map is the fallback when it is absent. SIP-direct agents whose
        // registered number is the dialled DID ring too.
        const parentAuthId = String(params.ParentAuthID || params.parentauthid || "");
        const account = registry.get(parentAuthId) || registry.byNumber(to);
        const agents = account ? registry.agentsOf(account.authId) : [];
        const directUsers = registry.sipDirectByNumber(to);
        if (agents.length === 0 && directUsers.length === 0) {
          console.warn(`[/answer] inbound to ${to || "?"} from ${from || "?"} (ParentAuthID ${parentAuthId || "-"}): no signed-in agent for this account or number; hanging up`);
          res.end(politeHangupXml("Sorry, no one is available to take your call right now. Please try again later."));
          return;
        }
        authId = account ? account.authId : parentAuthId;
        agentId = agents.length ? agents[0].agentId : "admin";
        sipDirect = agents.length === 0;
        callerId = registry.normalizeE164(to);
        sipTargets = agents.map((a) => `${a.sipUser}@${VOBIZ_REGISTRAR}`)
          .concat(directUsers.map((u) => `${u}@${VOBIZ_REGISTRAR}`));
      }

      const agent = getAgent(agentId);
      const ownerKnown = !sipDirect && (fromBrowser || sipTargets.length === 1);
      if (callUuid) {
        activeCalls.set(callUuid, {
          ...(activeCalls.get(callUuid) || {}),
          callUuid,
          // authId is only trusted for credential lookups when an account
          // signed in; for SIP-direct calls no token is held for it anyway.
          authId: sipDirect ? "" : authId,
          sipDirect,
          direction: fromBrowser ? "Outbound" : "Inbound",
          from: fromBrowser ? callerId : from,
          to: fromBrowser ? to : callerId,
          targetNumber: fromBrowser ? to : from,
          agentId,
          agentName: agent.name,
          // Owner of the Activity and Call Log: only when it is known who
          // takes the call. An outbound call is the signed-in agent's; an
          // inbound one is only when a single signed-in agent rings.
          pipedriveUserId: ownerKnown ? agent.pipedriveUserId : null,
          startTime: Date.now(),
        });
      }

      console.log(
        fromBrowser
          ? `[/answer] ${authId}: browser is the A leg, dialling out to ${to} as ${callerId}`
          : `[/answer] ${authId}: inbound from ${from}, ringing ${sipTargets.length} agent(s) callerId=${callerId}`
      );

      res.end(vobizAnswerXml(params, publicBaseUrl, sipTargets, callerId));
    } catch (err) {
      console.error("[/answer] Error generating XML:", err.message);
      // Vobiz reads a non-XML body as "no instructions" and drops the call, so
      // answer with valid XML even on the error path.
      if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/xml" });
      res.end('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
    }
    return;
  }

  // The `action` target of <Dial>. Reporting the result here is what stops the
  // platform replaying the answer document.
  //
  // DialBLegUUID is the single most useful field in this stack: empty means no
  // B leg was ever created, whatever the UI said.
  if (pathname === "/dial-status") {
    const d = req.method === "POST" ? { ...parsedUrl.query, ...(await readFormOrJsonBody(req)) } : parsedUrl.query;
    if (rejectUnverifiedWebhook(req, res, pathname, d)) return;
    const bleg = d.DialBLegUUID || "";
    console.log(
      `[DIAL RESULT] status=${d.DialStatus || "-"} ring=${d.DialRingStatus || "-"} ` +
      `cause=${d.DialHangupCause || "-"} bleg=${bleg || "(none — B leg never originated)"} ` +
      `dur=${d.DialBLegDuration || "-"}`
    );
    if (d.DialStatus === "failed" && !bleg) {
      console.error("  ⚠  failed with no B leg — destination unreachable, or the callerId is not owned by the account.");
    }
    const rec = activeCalls.get(String(d.CallUUID || ""));
    if (rec) {
      rec.dialStatus = d.DialStatus;
      rec.hangupCause = d.DialHangupCause;
      rec.bLegUuid = bleg || null;
      rec.duration = Number(d.DialBLegDuration || 0);
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("");
    return;
  }

  // 4. Recording Callback from Vobiz Voice Platform
  if (pathname === "/recording-callback" && req.method === "POST") {
    const body = await readFormOrJsonBody(req);
    if (rejectUnverifiedWebhook(req, res, pathname, body)) return;
    try {
      console.log("[/recording-callback] Received recording webhook:", body);

      const recordUrl = body.RecordUrl || body.RecordFile || body.recording_url || null;
      // The ID is what playback links are keyed on — the raw media URL is
      // never handed to a browser or written into a CRM note.
      const recordingId = body.RecordingID || body.RecordingId || body.recording_id || null;
      // Vobiz sends RecordingDuration; RecordDuration was never a field, so
      // every activity used to be logged with a zero duration.
      const duration = parseInt(body.RecordingDuration || body.RecordDuration || body.duration || 0, 10) || 0;
      const callUuid = body.CallUUID || body.call_uuid || "";
      if (!callUuid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "CallUUID is required" }));
        return;
      }
      const fromNumber = String(body.From || body.from || "");
      const toNumber = String(body.To || body.to || "");

      let callInfo = activeCalls.get(callUuid);
      if (!callInfo) {
        // A call this process did not see answered (e.g. after a restart).
        // Infer what we can — including which account it belongs to, so the
        // recording is fetched with the right credentials; never invent a number.
        const owner = accountForWebhook(body);
        const outbound = fromNumber.startsWith("sip:") ||
          Boolean(owner && owner.numbers.includes(registry.normalizeE164(fromNumber)));
        const target = outbound ? toNumber : fromNumber;
        const personMatch = target ? await getPipedrivePersonByPhone(target) : {};
        callInfo = {
          callUuid,
          authId: owner ? owner.authId : "",
          direction: outbound ? "Outbound" : "Inbound",
          from: fromNumber,
          to: toNumber,
          targetNumber: target,
          agentName: "",
          personId: personMatch.person_id,
          personName: personMatch.name,
          dealId: personMatch.deal_id
        };
      } else if (!callInfo.personId && callInfo.targetNumber) {
        const personMatch = await getPipedrivePersonByPhone(callInfo.targetNumber);
        callInfo.personId = personMatch.person_id;
        callInfo.personName = personMatch.name;
        callInfo.dealId = personMatch.deal_id;
      }

      callInfo.recordingUrl = recordUrl;
      callInfo.recordingId = recordingId;
      // Prefer the bridged B-leg duration from /dial-status when we have it.
      callInfo.duration = callInfo.duration || duration;
      callInfo.endTime = callInfo.endTime || Date.now();

      callRecordings.set(callUuid, callInfo);

      // Create Activity and Call Log in Pipedrive
      const activityRes = await createPipedriveActivity(callInfo);
      const callLogRes = await createPipedriveCallLog(callInfo);
      callInfo.crmSynced = Boolean(activityRes && activityRes.success && !activityRes.mocked);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "recording_logged",
        callUuid,
        pipedriveActivity: activityRes,
        pipedriveCallLog: callLogRes
      }));
    } catch (err) {
      console.error("[/recording-callback] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 5. Hangup Callback / CDR Metadata Callback
  if (pathname === "/hangup-callback" && req.method === "POST") {
    const body = await readFormOrJsonBody(req);
    if (rejectUnverifiedWebhook(req, res, pathname, body)) return;
    try {
      console.log("[/hangup-callback] Received hangup webhook:", body);

      const callUuid = body.CallUUID || body.call_uuid;
      const duration = parseInt(body.Duration || body.duration || 0, 10);
      const hangupCause = body.HangupCause || body.hangup_cause || "NORMAL_CLEARING";

      if (callUuid && activeCalls.has(callUuid)) {
        const callInfo = activeCalls.get(callUuid);
        callInfo.duration = duration || callInfo.duration || 0;
        callInfo.hangupCause = hangupCause;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "hangup_recorded" }));
    } catch (err) {
      console.error("[/hangup-callback] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 5b. Hang up a call by UUID over the REST API, with the signed-in
  // account's credentials only (from the server-side registry, never from the
  // request). It used to need no session, so anyone could end anyone's call.
  if (pathname === "/hangup-call" && req.method === "POST") {
    const session = requireSession(req, res);
    if (!session) return;
    const account = registry.get(session.authId);
    try {
      const body = await readJsonBody(req);
      const callUuid = String(body.callUuid || "").trim();
      if (!/^[A-Za-z0-9-]{8,64}$/.test(callUuid)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "callUuid is required" }));
        return;
      }
      if (!account) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Sign in again" }));
        return;
      }
      const r = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(account.authId)}/Call/${encodeURIComponent(callUuid)}/`, {
        method: "DELETE",
        headers: { "X-Auth-ID": account.authId, "X-Auth-Token": account.authToken },
      });
      const ok = r.ok || r.status === 204;
      res.writeHead(ok ? 200 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { success: true } : { success: false, error: `Vobiz returned ${r.status}` }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 5d. Latest recording for a call, as a signed playback link. No raw media
  // URLs, and no placeholder "sample" recording when there is none.
  if ((pathname === "/api/recording-info" || pathname === "/recording-info") && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    const uuid = parsedUrl.query.uuid;
    const mine = Array.from(callRecordings.values()).filter((c) => c.authId === session.authId);
    const rec = uuid ? mine.find((c) => c.callUuid === uuid) : mine.pop();
    if (!rec || !rec.recordingId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, status: "pending" }));
      return;
    }
    const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      callUuid: rec.callUuid,
      playUrl: signRecordingUrl(rec.authId, rec.recordingId, publicBaseUrl),
      duration: rec.duration || 0,
    }));
    return;
  }

  // 6. Call recording audio, signature-gated.
  //
  // This endpoint used to take a `url` query parameter and fetch it with the
  // account's Vobiz credentials attached:
  //
  //     headers["X-Auth-Token"] = activeAuthToken;
  //     await fetch(targetUrl, { headers });      // targetUrl fully caller-controlled
  //
  // That is a credential-exfiltration primitive, not merely SSRF: unauthenticated,
  // CORS-open, and it would post the account Auth Token to any host a caller
  // named. It now takes a recording ID, resolves the real media URL server-side
  // through the Vobiz API, and refuses any host outside the allowlist — on the
  // first request and again after each redirect.
  if (pathname === "/recording-file") {
    try {
      const recordingId = parsedUrl.query.recordingId;
      if (!recordingId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "recordingId is required" }));
        return;
      }
      const authId = String(parsedUrl.query.authId || "");
      if (!verifyRecordingSignature(authId, recordingId, parsedUrl.query.exp, parsedUrl.query.sig)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "This playback link is invalid or has expired." }));
        return;
      }

      const media = await fetchRecordingMedia(registry.get(authId), recordingId);
      if (media.error) {
        res.writeHead(media.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: media.error }));
        return;
      }
      res.writeHead(200, { "Content-Type": media.contentType, "Content-Length": media.buffer.length, "Cache-Control": "private, no-store" });
      res.end(media.buffer);
    } catch (err) {
      console.error("[/recording-file] error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Could not stream that recording" }));
    }
    return;
  }

  // 7. Pipedrive Contact Lookup Endpoint (for Softphone UI)
  if (pathname === "/api/pipedrive/persons/lookup") {
    if (!requireSession(req, res)) return;
    try {
      const phone = parsedUrl.query.phone;
      if (!phone) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'phone' parameter" }));
        return;
      }
      const match = await getPipedrivePersonByPhone(phone);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(match));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 8. Trigger Live CDR Fetch & Sync to Pipedrive
  if (pathname === "/sync-recent-cdrs" && (req.method === "POST" || req.method === "GET")) {
    // Behind the session: this writes to the CRM.
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const account = registry.get(session.authId);
      if (!account) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Sign in again" }));
        return;
      }

      const headers = {
        "X-Auth-ID": account.authId,
        "X-Auth-Token": account.authToken
      };

      const cdrRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(account.authId)}/cdr/recent?limit=10`, { headers });
      const cdrJson = await cdrRes.json();
      const cdrs = cdrJson.data || [];

      let syncedCount = 0;
      let mockedCount = 0;
      let failedCount = 0;
      let notConfigured = false;
      for (const cdr of cdrs) {
        const targetNumber = cdr.call_direction === "inbound" ? cdr.caller_id_number : cdr.destination_number;
        const personMatch = await getPipedrivePersonByPhone(targetNumber);

        const callInfo = {
          callUuid: cdr.uuid,
          authId: account.authId,
          direction: cdr.call_direction === "inbound" ? "Inbound" : "Outbound",
          from: cdr.caller_id_number,
          to: cdr.destination_number,
          targetNumber,
          agentName: "",
          personId: personMatch.person_id,
          personName: personMatch.name,
          dealId: personMatch.deal_id,
          duration: cdr.duration || 0,
          startTime: Date.parse(cdr.start_time) || undefined,
          hangupCause: cdr.hangup_cause || "",
          recordingUrl: cdr.recording_url || null
        };

        // syncedCount used to increment unconditionally, so this reported
        // "synced 10" while Pipedrive was not configured and nothing had been
        // written anywhere. Count what actually landed.
        const activity = await createPipedriveActivity(callInfo);
        await createPipedriveCallLog(callInfo);
        if (activity && activity.pipedriveConfigured === false) notConfigured = true;
        else if (activity && activity.mocked) mockedCount++;
        else if (activity && activity.success !== false) syncedCount++;
        else failedCount++;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: notConfigured ? "not_configured" : "sync_completed",
        pipedriveConfigured: !notConfigured,
        synced: syncedCount,
        syncedCount,            // retained for older callers
        mocked: mockedCount > 0,
        mockedCount,
        failed: failedCount,
        fetchedCdrs: cdrs.length
      }));
    } catch (err) {
      console.error("[/sync-recent-cdrs] Exception:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 9. Static files: the softphone and the Pipedrive panel, nothing else.
  if (req.method === "GET" || req.method === "HEAD") {
    const filePath = resolveStaticFile(pathname);
    if (filePath) {
      res.writeHead(200, { "Content-Type": contentTypeFor(filePath), "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Vobiz Pipedrive Backend Server Running`);
  console.log(`==================================================`);
  console.log(`- Local URL:        http://localhost:${PORT}`);
  console.log(`- Softphone UI:     http://localhost:${PORT}/agent-phone/index.html`);
  console.log(`- Pipedrive CTI App: http://localhost:${PORT}/pipedrive-app/pipedrive-cti-app.html`);
  console.log(`- Health Check:     http://localhost:${PORT}/health`);
  console.log(`- Public Tunnel:    ${getPublicBaseUrl() || "None (Run 'npm run tunnel' to start)"}`);
  console.log(`==================================================\n`);
});
