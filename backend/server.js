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
  if (process.env.TUNNEL_URL) {
    return process.env.TUNNEL_URL.trim();
  }
  try {
    const urlStr = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    return urlStr || null;
  } catch {
    return null;
  }
}

const cleanEnvVar = (val) => val?.trim().replace(/^["']|["']$/g, "") || "";

const VOBIZ_AUTH_ID = cleanEnvVar(process.env.VOBIZ_AUTH_ID);
const VOBIZ_AUTH_TOKEN = cleanEnvVar(process.env.VOBIZ_AUTH_TOKEN);
const VOBIZ_FROM_NUMBER = cleanEnvVar(process.env.VOBIZ_FROM_NUMBER);
const PORT = cleanEnvVar(process.env.PORT) || "8092";
const VOBIZ_API_URL = cleanEnvVar(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai";

const PIPEDRIVE_API_TOKEN = cleanEnvVar(process.env.PIPEDRIVE_API_TOKEN);
const PIPEDRIVE_COMPANY_DOMAIN = cleanEnvVar(process.env.PIPEDRIVE_COMPANY_DOMAIN) || "yourcompany";
const PIPEDRIVE_API_URL = cleanEnvVar(process.env.PIPEDRIVE_API_URL) || "https://api.pipedrive.com/v1";

const crypto = require("crypto");

// ─── recording link signing ─────────────────────────────────────────────────
// A plain <audio> element cannot send an Authorization header, so a playback
// URL has to carry its own proof. It must never carry account credentials:
// these links end up in CRM activity notes, where they are readable by every
// user of the account, indefinitely.
const SIGNING_SECRET = cleanEnvVar(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(cleanEnvVar(process.env.RECORDING_URL_TTL_SECONDS) || 900);

function signRecordingUrl(recordingId, baseUrl) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  const base = (baseUrl || "").replace(/\/+$/, "");
  return `${base}/recording-file?recordingId=${encodeURIComponent(recordingId)}&exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(recordingId, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
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

const VOBIZ_SIP_USER = cleanEnvVar(process.env.VOBIZ_SIP_USER);
const VOBIZ_SIP_PASSWORD = cleanEnvVar(process.env.VOBIZ_SIP_PASSWORD);
const VOBIZ_REGISTRAR = cleanEnvVar(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";

// token -> { agentId, authId, createdAt }. The Vobiz Auth Token is never stored
// per-session and never returned to the browser.
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

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
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

/** The account's DIDs, read with the server's own credentials. */
async function fetchAccountNumbers() {
  let numbers = [];
  if (VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN) {
    try {
      const r = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${encodeURIComponent(VOBIZ_AUTH_ID)}/numbers?per_page=100`, {
        headers: { "X-Auth-ID": VOBIZ_AUTH_ID, "X-Auth-Token": VOBIZ_AUTH_TOKEN, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const data = await r.json();
        const raw = data.items || data.numbers || data.objects || (Array.isArray(data) ? data : []);
        numbers = raw.map((n) => (typeof n === "string" ? n : (n.e164 || n.number || n.phone_number || n.alias))).filter(Boolean);
      } else {
        console.warn(`[numbers] Vobiz returned ${r.status} listing numbers`);
      }
    } catch (e) {
      console.warn("[numbers] could not list account numbers:", e.message);
    }
  }
  numbers = Array.from(new Set(numbers));
  if (numbers.length === 0 && VOBIZ_FROM_NUMBER) numbers = [VOBIZ_FROM_NUMBER];
  return numbers;
}

const PIPEDRIVE_ALLOW_API_TOKEN = /^(1|true|yes)$/i.test(cleanEnvVar(process.env.PIPEDRIVE_ALLOW_API_TOKEN));

const ALLOW_MOCK = /^(1|true|yes)$/i.test(cleanEnvVar(process.env.ALLOW_MOCK));

const AGENTS_FILE = path.join(__dirname, "agents.json");

/**
 * The SIP endpoint this backend actually bridges to.
 *
 * agents.json ships placeholder identities like `admin@sip.vobiz.ai`, which are
 * not registered anywhere. Using them for <Dial><User> dials an endpoint that
 * does not exist: the caller hears ringback and then the fallback, with no B
 * leg and nothing in the softphone. The registered endpoint comes from .env.
 */
function resolveSipUser(agent) {
  if (VOBIZ_SIP_USER) return `${VOBIZ_SIP_USER}@${VOBIZ_REGISTRAR}`;
  return (agent && agent.sipUser) || "";
}

function getAgent(agentId) {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
      return agents[agentId] || agents["admin"] || null;
    }
  } catch (err) {
    console.error("[backend] Error reading agents.json:", err.message);
  }
  return {
    name: "System Administrator",
    sipUser: "admin@sip.vobiz.ai",
    pipedriveUserId: 1001,
    pipedriveEmail: "admin@yourcompany.pipedrive.com"
  };
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
function vobizAnswerXml(params, publicBaseUrl, sipUser, callerId) {
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${record}
  <Dial ${dialAttrs}>
    <User>sip:${escapeXmlText(String(sipUser).replace(/^sip:/, ""))}</User>
  </Dial>
</Response>`;
}

const escapeXmlText = (v) =>
  String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeXmlAttr = (v) => escapeXmlText(v).replace(/"/g, "&quot;");

/**
 * Inbound caller ID, normalised to E.164 from the number that was dialled.
 *
 * `callerId` is mandatory. Omit it and Vobiz derives it from the A leg — which
 * on an inbound call is the *caller's* number, one this account does not own —
 * so B-leg creation is refused outright and silently: no B-leg CDR, no INVITE
 * to the browser, the caller just hears the fallback.
 */
function toE164(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("+")) return v;
  if (v.startsWith("0") && v.length === 11) return `+91${v.slice(1)}`;
  const digits = v.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

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
      deal_title: "VoBiz Enterprise Expansion Deal"
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
        deal_id: null
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
        deal_id: null
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
        subject: `VoBiz ${callInfo.direction} Call - ${callInfo.targetNumber}`,
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
    const proxyRecordingUrl = callInfo.recordingId
      ? signRecordingUrl(callInfo.recordingId, publicBaseUrl)
      : null;

    const formattedDuration = formatDuration(callInfo.duration);
    
    // HTML Formatted Note for Pipedrive Activity
    const noteHtml = `
<h3>📞 VoBiz Telephony Call Log</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-family: sans-serif; font-size: 13px;">
  <tr style="background-color: #f4f5f7;"><th>Parameter</th><th>Value</th></tr>
  <tr><td><b>Call UUID</b></td><td><code>${callInfo.callUuid || "N/A"}</code></td></tr>
  <tr><td><b>Direction</b></td><td>${callInfo.direction}</td></tr>
  <tr><td><b>From</b></td><td>${callInfo.from}</td></tr>
  <tr><td><b>To</b></td><td>${callInfo.to}</td></tr>
  <tr><td><b>Agent</b></td><td>${callInfo.agentName || "System Administrator"}</td></tr>
  <tr><td><b>Duration</b></td><td>${formattedDuration} (${callInfo.duration || 0}s)</td></tr>
  <tr><td><b>Hangup Cause</b></td><td><code>${callInfo.hangupCause || "NORMAL_CLEARING"}</code></td></tr>
  <tr><td><b>Status</b></td><td><span style="color: green; font-weight: bold;">COMPLETED</span></td></tr>
  <tr><td><b>Timestamp</b></td><td>${new Date().toISOString()}</td></tr>
</table>
${proxyRecordingUrl ? `<p style="margin-top:12px;">▶️ <b>Call Recording:</b> <a href="${proxyRecordingUrl}" target="_blank" style="color:#00875a; font-weight:bold;">Listen / Download Audio MP3</a></p>` : "<p><i>No call recording available for this call.</i></p>"}
`;

    const body = {
      subject: `VoBiz ${callInfo.direction} Call - ${callInfo.targetNumber}`,
      type: "call",
      done: 1,
      duration: formattedDuration,
      note: noteHtml,
      public_description: `VoBiz ${callInfo.direction} Call Log (${formattedDuration})`,
      person_id: callInfo.personId || undefined,
      deal_id: callInfo.dealId || undefined
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

async function createPipedriveCallLog(callInfo) {
  if (!pipedriveAvailable()) {
    return { success: true, mock: true };
  }

  try {
    const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
    // Signed, expiring, and keyed by recording ID — never the media URL, and
    // never carrying credentials. This link is written into a CRM note, where
    // everyone on the account can read it for as long as the record exists.
    const proxyRecordingUrl = callInfo.recordingId
      ? signRecordingUrl(callInfo.recordingId, publicBaseUrl)
      : null;

    const body = {
      to_call_number: callInfo.to,
      phone_number: callInfo.from,
      outcome: "connected",
      duration: String(callInfo.duration || 0),
      person_id: callInfo.personId || undefined,
      deal_id: callInfo.dealId || undefined,
      has_recording: !!proxyRecordingUrl,
      recording_url: proxyRecordingUrl || undefined,
      start_time: new Date().toISOString().slice(0, 19).replace("T", " ")
    };

    const res = await pipedriveRequest("/callLogs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });

    const json = await res.json();
    if (json.success) {
      console.log(`[Pipedrive] Successfully created CallLog entry ID #${json.data?.id}`);
    }
    return json;
  } catch (err) {
    console.error("[Pipedrive] CallLog creation notice:", err.message);
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
      vobizConfigured: Boolean(VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN),
      sipConfigured: Boolean(VOBIZ_SIP_USER && VOBIZ_SIP_PASSWORD),
      pipedriveConnected: pipedriveAvailable(),
      publicUrlConfigured: Boolean(getPublicBaseUrl()),
    }));
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

  // Sign-in. The agent proves they hold THIS server's Vobiz Auth ID and Auth
  // Token and gets an opaque session token back.
  //
  // This used to ask Vobiz whether the pair was valid and then treat a 307, or
  // any response at all when the Auth ID merely matched the server's, as
  // success — so the Auth ID alone (it is printed in /health and on every
  // screenshot) signed you in, and the session then handed out the SIP
  // password. A valid pair for some *other* Vobiz account was also accepted,
  // though every call is billed to this one. The comparison is now local,
  // exact and constant-time, and there is no mock bypass.
  if ((pathname === "/api/login" || pathname === "/login") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const authId = String(body.authId || "").trim();
      const authToken = String(body.authToken || "").trim();
      const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : "admin";

      if (!authId || !authToken) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Both Vobiz Auth ID and Auth Token are required." }));
        return;
      }
      if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN are not configured on this server." }));
        return;
      }
      // Evaluate both comparisons so timing does not reveal which one failed.
      const idOk = safeEqual(authId, VOBIZ_AUTH_ID);
      const tokenOk = safeEqual(authToken, VOBIZ_AUTH_TOKEN);
      if (!(idOk && tokenOk)) {
        console.log(`[/api/login] rejected sign-in attempt for ${authId.slice(0, 12)}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid Vobiz Auth ID or Auth Token. Use the API credentials of the account this server is configured for (console.vobiz.ai → API credentials)." }));
        return;
      }

      const agent = getAgent(agentId);
      const numbers = await fetchAccountNumbers();
      const selectedNumber = numbers[0] || "";

      // The browser gets an opaque session token, never the Auth Token back.
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { agentId, authId, numbers, from: selectedNumber, createdAt: Date.now() });

      console.log(`[/api/login] ${agentId} signed in`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        message: "Signed in to Vobiz.",
        token,
        authId,
        numbers,
        selected: selectedNumber,
        agent: { id: agentId, name: agent.name, email: agent.pipedriveEmail },
      }));
    } catch (err) {
      console.error("[/api/login] Exception:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Sign-in failed" }));
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
    if (token) sessions.delete(token);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, success: true }));
    return;
  }

  // Recent recordings, each with a signed, short-lived playback link.
  // Behind the session: the signed links ARE the access control for the audio,
  // so handing them to anyone who asked made the signature pointless.
  if ((pathname === "/recordings" || pathname === "/api/recordings") && req.method === "GET") {
    if (!requireSession(req, res)) return;
    try {
      const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
      const limit = Math.min(Math.max(Number(parsedUrl.query.limit) || 15, 1), 50);
      let recordings = [];
      if (VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN) {
        try {
          const r = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Recording/?limit=${limit}`, {
            headers: { "X-Auth-ID": VOBIZ_AUTH_ID, "X-Auth-Token": VOBIZ_AUTH_TOKEN, Accept: "application/json" }
          });
          if (r.ok) {
            const data = await r.json();
            const objects = data.objects || data.items || [];
            recordings = objects.filter((o) => o.recording_id).map((o) => ({
              recording_id: o.recording_id,
              add_time: o.add_time,
              rounded_recording_duration: o.rounded_recording_duration,
              call_uuid: o.call_uuid,
              playUrl: signRecordingUrl(o.recording_id, publicBaseUrl),
            }));
          }
        } catch (e) {
          console.warn("[/recordings] Vobiz API fetch notice:", e.message);
        }
      }
      if (recordings.length === 0 && callRecordings.size > 0) {
        recordings = Array.from(callRecordings.values()).filter((c) => c.recordingId).map((c) => ({
          recording_id: c.recordingId,
          add_time: new Date(c.startTime || Date.now()).toISOString(),
          rounded_recording_duration: c.duration || 0,
          call_uuid: c.callUuid,
          playUrl: signRecordingUrl(c.recordingId, publicBaseUrl),
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
    if (!requireSession(req, res)) return;
    const callUuid = parsedUrl.query.callUuid;
    const publicBaseUrl = getPublicBaseUrl() || `http://localhost:${PORT}`;
    const rec = callUuid ? (callRecordings.get(callUuid) || activeCalls.get(callUuid)) : null;
    if (rec && rec.recordingId) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playUrl: signRecordingUrl(rec.recordingId, publicBaseUrl) }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Recording not found for this call" }));
    return;
  }

  // SIP credentials for the softphone to register with.
  //
  // Behind the session deliberately. SIP credentials let anyone place calls
  // billed to this account, so they are never served to an unauthenticated
  // caller and never embedded in agents.json, which is committed.
  if (pathname === "/api/agent-sip" && req.method === "GET") {
    const session = requireSession(req, res);
    if (!session) return;
    if (!VOBIZ_SIP_USER || !VOBIZ_SIP_PASSWORD) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "VOBIZ_SIP_USER / VOBIZ_SIP_PASSWORD are not configured on this server" }));
      return;
    }
    const agent = getAgent(session.agentId);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      displayName: agent.name,
      sipUser: `${VOBIZ_SIP_USER}@${VOBIZ_REGISTRAR}`,
      sipPassword: VOBIZ_SIP_PASSWORD,
      registrarUrl: `wss://${VOBIZ_REGISTRAR}:5063/`,
    }));
    return;
  }

  // The account's numbers, for the caller-ID picker.
  if ((pathname === "/numbers" || pathname === "/api/numbers") && req.method === "GET") {
    if (!requireSession(req, res)) return;
    const numbers = await fetchAccountNumbers();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ numbers, count: numbers.length }));
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

  // 3. Answer & Fallback Callback - Returns VoBiz XML to Dial Agent Softphone & Record Call
  if ((pathname === "/answer" || pathname === "/fallback") && (req.method === "POST" || req.method === "GET")) {
    try {
      const body = req.method === "POST" ? await readFormOrJsonBody(req) : {};
      const params = { ...parsedUrl.query, ...body };
      const agentId = params.agentId || "admin";
      const agent = getAgent(agentId);
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

      // Outbound: the softphone sends the caller ID it picked as an X-VH-Caller-ID
      // SIP header, which Vobiz passes to this URL as an X-VH- parameter. Only a
      // phone-number shape is accepted; Vobiz itself refuses a caller ID the
      // account does not own.
      // Inbound: must answer with the DID that was actually dialled, or the B
      // leg is never created.
      const headerCallerId = String(
        params["X-VH-Caller-ID"] || params["SIPHeader_X-VH-Caller-ID"] || params["X-PH-Caller-ID"] || ""
      ).trim();
      const pickedCallerId = /^\+?\d{6,15}$/.test(headerCallerId) ? toE164(headerCallerId) : "";
      const callerId = fromBrowser
        ? (pickedCallerId || VOBIZ_FROM_NUMBER)
        : (toE164(to) || VOBIZ_FROM_NUMBER);

      const callUuid = params.CallUUID || params.call_uuid || "";
      if (callUuid) {
        activeCalls.set(callUuid, {
          ...(activeCalls.get(callUuid) || {}),
          callUuid,
          direction: fromBrowser ? "Outbound" : "Inbound",
          from: fromBrowser ? callerId : from,
          to: fromBrowser ? to : callerId,
          targetNumber: fromBrowser ? to : from,
          agentId,
          agentName: agent.name,
          pipedriveUserId: agent.pipedriveUserId,
          startTime: Date.now(),
        });
      }

      console.log(
        fromBrowser
          ? `[/answer] browser is the A leg, dialling out to ${to} as ${callerId}`
          : `[/answer] inbound from ${from}, bridging to ${resolveSipUser(agent)} callerId=${callerId}`
      );

      res.end(vobizAnswerXml(params, publicBaseUrl, resolveSipUser(agent), callerId));
    } catch (err) {
      console.error("[/answer] Error generating XML:", err.message);
      // Vobiz reads a non-XML body as "no instructions" and drops the call, so
      // answer with valid XML even on the error path.
      res.writeHead(200, { "Content-Type": "application/xml" });
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
    const bleg = d.DialBLegUUID || "";
    console.log(
      `[DIAL RESULT] status=${d.DialStatus || "-"} ring=${d.DialRingStatus || "-"} ` +
      `cause=${d.DialHangupCause || "-"} bleg=${bleg || "(none — B leg never originated)"} ` +
      `dur=${d.DialBLegDuration || "-"}`
    );
    if (d.DialStatus === "failed" && !bleg) {
      console.error("  ⚠  failed with no B leg — destination unreachable, or the callerId is not owned by this account.");
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

  // 4. Recording Callback from VoBiz Voice Platform
  if (pathname === "/recording-callback" && req.method === "POST") {
    try {
      const body = await readFormOrJsonBody(req);
      console.log("[/recording-callback] Received recording webhook:", body);

      const recordUrl = body.RecordUrl || body.recording_url || body.url;
      // The ID is what playback links are keyed on now — the raw media URL is
      // never handed to a browser or written into a CRM note.
      const recordingId = body.RecordingID || body.RecordingId || body.recording_id || null;
      const duration = parseInt(body.RecordDuration || body.duration || 0, 10);
      const callUuid = body.CallUUID || body.call_uuid || body.request_uuid || `rec-${Date.now()}`;
      const fromNumber = body.From || body.from || VOBIZ_FROM_NUMBER;
      const toNumber = body.To || body.to || "+15550192834";

      let callInfo = activeCalls.get(callUuid);
      if (!callInfo) {
        // Fallback for inbound or untracked calls
        const personMatch = await getPipedrivePersonByPhone(fromNumber === VOBIZ_FROM_NUMBER ? toNumber : fromNumber);
        callInfo = {
          callUuid,
          direction: fromNumber === VOBIZ_FROM_NUMBER ? "Outbound" : "Inbound",
          from: fromNumber,
          to: toNumber,
          targetNumber: fromNumber === VOBIZ_FROM_NUMBER ? toNumber : fromNumber,
          agentName: "System Administrator",
          pipedriveUserId: 1001,
          personId: personMatch.person_id,
          personName: personMatch.name,
          dealId: personMatch.deal_id
        };
      }

      callInfo.recordingUrl = recordUrl;
      callInfo.recordingId = recordingId;
      callInfo.duration = duration;
      callInfo.hangupCause = callInfo.hangupCause || "NORMAL_CLEARING";

      callRecordings.set(callUuid, callInfo);

      // Create Activity and CallLog in Pipedrive
      const activityRes = await createPipedriveActivity(callInfo);
      await createPipedriveCallLog(callInfo);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "recording_logged",
        callUuid,
        pipedriveActivity: activityRes
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
    try {
      const body = await readFormOrJsonBody(req);
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

  // 5b. Hang up a call by UUID over the REST API, with the server's own
  // credentials only. It used to accept authId/authToken from the request
  // and needed no session, so anyone could end anyone's call.
  if (pathname === "/hangup-call" && req.method === "POST") {
    if (!requireSession(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const callUuid = String(body.callUuid || "").trim();
      if (!/^[A-Za-z0-9-]{8,64}$/.test(callUuid)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "callUuid is required" }));
        return;
      }
      const r = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Call/${encodeURIComponent(callUuid)}/`, {
        method: "DELETE",
        headers: { "X-Auth-ID": VOBIZ_AUTH_ID, "X-Auth-Token": VOBIZ_AUTH_TOKEN },
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
    if (!requireSession(req, res)) return;
    const uuid = parsedUrl.query.uuid;
    const rec = uuid ? callRecordings.get(uuid) : Array.from(callRecordings.values()).pop();
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
      playUrl: signRecordingUrl(rec.recordingId, publicBaseUrl),
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
      if (!verifyRecordingSignature(recordingId, parsedUrl.query.exp, parsedUrl.query.sig)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "This playback link is invalid or has expired." }));
        return;
      }

      // Credentials come from the server's own config. They are never read from
      // the query string or from request headers, so a caller cannot supply
      // someone else's and cannot steer where ours are sent.
      if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Vobiz credentials are not configured on this server" }));
        return;
      }
      const authHeaders = {
        "X-Auth-ID": VOBIZ_AUTH_ID,
        "X-Auth-Token": VOBIZ_AUTH_TOKEN,
        Accept: "application/json"
      };

      const metaRes = await fetch(
        `${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Recording/${encodeURIComponent(recordingId)}/`,
        { headers: authHeaders }
      );
      if (!metaRes.ok) {
        res.writeHead(metaRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Vobiz returned ${metaRes.status} for that recording` }));
        return;
      }
      const meta = await metaRes.json().catch(() => ({}));
      const mediaUrl = meta.recording_url || meta.url;
      if (!mediaUrl) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No audio is available for that recording yet" }));
        return;
      }
      if (!isAllowedMediaHost(mediaUrl)) {
        console.error(`[/recording-file] refusing off-allowlist media host: ${mediaUrl}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Recording is hosted somewhere this server will not fetch from" }));
        return;
      }

      let mediaRes = await fetch(mediaUrl, { headers: authHeaders, redirect: "manual" });

      // Recordings are commonly served as a redirect to presigned object
      // storage. Follow one hop, but re-check the host — and drop the auth
      // headers, because a presigned URL carries its own authorisation and
      // forwarding ours to a third party is the bug this endpoint just had.
      let hops = 0;
      while (mediaRes.status >= 300 && mediaRes.status < 400 && hops < 3) {
        const location = mediaRes.headers.get("location");
        if (!location) break;
        const next = new URL(location, mediaUrl).toString();
        if (!isAllowedMediaHost(next)) {
          console.error(`[/recording-file] refusing redirect to ${next}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Recording redirected somewhere this server will not follow" }));
          return;
        }
        mediaRes = await fetch(next, { redirect: "manual" });
        hops++;
      }

      if (!mediaRes.ok) {
        res.writeHead(mediaRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Media server returned ${mediaRes.status}` }));
        return;
      }

      const contentType = mediaRes.headers.get("content-type") || "audio/mpeg";
      const headersOut = { "Content-Type": contentType, "Accept-Ranges": "bytes" };
      const len = mediaRes.headers.get("content-length");
      if (len) headersOut["Content-Length"] = len;
      res.writeHead(200, headersOut);
      res.end(Buffer.from(await mediaRes.arrayBuffer()));
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
    if (!requireSession(req, res)) return;
    try {
      if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "not_configured", error: "VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN are not configured on this server" }));
        return;
      }

      const headers = {
        "X-Auth-ID": VOBIZ_AUTH_ID,
        "X-Auth-Token": VOBIZ_AUTH_TOKEN
      };

      const cdrRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/cdr/recent?limit=10`, { headers });
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
          direction: cdr.call_direction === "inbound" ? "Inbound" : "Outbound",
          from: cdr.caller_id_number,
          to: cdr.destination_number,
          targetNumber,
          agentName: "System Administrator",
          pipedriveUserId: 1001,
          personId: personMatch.person_id,
          personName: personMatch.name,
          dealId: personMatch.deal_id,
          duration: cdr.duration || 0,
          hangupCause: cdr.hangup_cause || "NORMAL_CLEARING",
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
  console.log(`🚀 VoBiz Pipedrive Backend Server Running`);
  console.log(`==================================================`);
  console.log(`- Local URL:        http://localhost:${PORT}`);
  console.log(`- Softphone UI:     http://localhost:${PORT}/agent-phone/index.html`);
  console.log(`- Pipedrive CTI App: http://localhost:${PORT}/pipedrive-app/pipedrive-cti-app.html`);
  console.log(`- Health Check:     http://localhost:${PORT}/health`);
  console.log(`- Public Tunnel:    ${getPublicBaseUrl() || "None (Run 'npm run tunnel' to start)"}`);
  console.log(`==================================================\n`);
});
