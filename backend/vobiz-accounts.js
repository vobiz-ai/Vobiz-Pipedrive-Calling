/**
 * Multi-tenant Vobiz accounts.
 *
 * Any Vobiz customer can sign in with their own Auth ID + Auth Token. Nothing
 * account-specific lives in the environment or in tracked files:
 *
 *   - The Auth Token is kept in memory only, keyed by Auth ID. It is never
 *     written to disk, never logged and never returned to a browser.
 *   - On sign-in this integration finds (or creates) its own Application in
 *     that account — matched on answer_url === <public base>/answer — and one
 *     SIP endpoint per (Auth ID, agent). The endpoint id and its username are
 *     persisted (mode 0600, gitignored); the SIP password is not. A fresh
 *     random password is set on every sign-in and handed only to that browser
 *     session.
 *   - Webhooks are routed back to the right account by SIP username
 *     (outbound) or by the dialled number (inbound).
 *
 * Vobiz app ids are 17 digits, above Number.MAX_SAFE_INTEGER. They are kept as
 * strings end to end: responses are read with big integers quoted before
 * JSON.parse, and request bodies that must carry the integer splice the
 * validated digit string into the raw JSON text.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APP_NAME = "Vobiz-Pipedrive-Calling";

function createAccountRegistry({ apiUrl, dataDir, publicBaseUrl, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const ENDPOINTS_FILE = path.join(dataDir, "endpoints.json");

  // authId -> { authId, authToken, numbers: [e164], appId }
  const accounts = new Map();
  // sipUsername -> { authId, agentId, callerId }
  const sipUsers = new Map();
  // SIP-direct agents (typed an existing endpoint's credentials; no account
  // API access): sipUsername -> { callerId, inboundNumber, claimToken, at }
  const sipDirect = new Map();
  const SIP_DIRECT_MAX = 1000;
  // per-key promise chain, so two sign-ins at once do not create two apps
  const locks = new Map();

  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next.finally(() => { if (locks.get(key) === next) locks.delete(key); }));
    return next;
  }

  // ── storage ────────────────────────────────────────────────────────────────
  function readStore() {
    try { return JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8")) || {}; } catch { return {}; }
  }
  function writeStore(store) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${ENDPOINTS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ENDPOINTS_FILE);
    try { fs.chmodSync(ENDPOINTS_FILE, 0o600); } catch { /* best effort */ }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  /** Quote id-like integers so JSON.parse cannot round them. */
  function safeParse(text) {
    const quoted = String(text || "").replace(
      /("(?:app_id|endpoint_id|application|application_id|id)"\s*:\s*)(-?\d{6,})(?=\s*[,}\]])/g,
      '$1"$2"'
    );
    try { return JSON.parse(quoted); } catch { return null; }
  }

  async function vobiz(account, method, apiPath, rawBody) {
    const headers = { "X-Auth-ID": account.authId, "X-Auth-Token": account.authToken, Accept: "application/json" };
    if (rawBody !== undefined) headers["Content-Type"] = "application/json";
    const res = await doFetch(`${apiUrl}/api/v1/Account/${encodeURIComponent(account.authId)}${apiPath}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, ok: res.ok, text, json: safeParse(text) };
  }

  function idString(v) {
    const s = v == null ? "" : String(v);
    return /^\d+$/.test(s) ? s : "";
  }

  function normalizeE164(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    // A domestic 0-prefixed Indian number (0 + 10 digits).
    if (/^0\d{10}$/.test(v)) return `+91${v.slice(1)}`;
    const digits = v.replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }

  /**
   * The account's numbers, from GET /numbers?page=N&per_page=100, every page
   * until `total` is loaded. Response: { items: [{ e164, status,
   * voice_enabled, application_id, ... }], page, per_page, total }.
   *
   * Returns { status, ok, all: [e164], callerIds: [{ e164, applicationId }] }
   * where callerIds holds only numbers usable as an outbound caller ID:
   * status === "active" and voice_enabled !== false.
   */
  async function loadNumbers(account) {
    const all = [];
    const callerIds = [];
    let total = Infinity;
    for (let page = 1; page <= 50 && all.length < total; page++) {
      const r = await vobiz(account, "GET", `/numbers?page=${page}&per_page=100`);
      if (!r.ok) return { ok: false, status: r.status };
      const data = r.json || {};
      const items = Array.isArray(data.items) ? data.items : [];
      if (Number.isFinite(Number(data.total))) total = Number(data.total);
      for (const n of items) {
        const e164 = normalizeE164(n && n.e164);
        if (!e164 || all.includes(e164)) continue;
        all.push(e164);
        if (String(n.status || "").toLowerCase() === "active" && n.voice_enabled !== false) {
          callerIds.push({ e164, applicationId: n.application_id == null ? "" : String(n.application_id) });
        }
      }
      if (items.length === 0 || items.length < 100 && !Number.isFinite(total)) break;
    }
    return { ok: true, all, callerIds };
  }

  // ── sign-in ────────────────────────────────────────────────────────────────
  /**
   * Check the pair against Vobiz (the numbers list doubles as the probe).
   * Never throws on a refusal; only a 2xx counts.
   */
  async function verify(authId, authToken) {
    return loadNumbers({ authId, authToken });
  }

  function applyNumbers(account, loaded) {
    account.allNumbers = loaded.all;
    account.numberDetails = loaded.callerIds;
    account.numbers = loaded.callerIds.map((n) => n.e164);
  }

  function answerUrl() {
    const base = String(publicBaseUrl() || "").replace(/\/+$/, "");
    return base ? `${base}/answer` : "";
  }

  /** Every object of a paginated Vobiz list. */
  async function listAll(account, apiPath, what) {
    const out = [];
    for (let offset = 0, page = 0; page < 20; page++) {
      const r = await vobiz(account, "GET", `${apiPath}?limit=100&offset=${offset}`);
      if (!r.ok) throw Object.assign(new Error(`Vobiz returned ${r.status} listing ${what}`), { status: 502 });
      const objects = (r.json && r.json.objects) || [];
      out.push(...objects.filter(Boolean));
      if (objects.length < 100) break;
      offset += 100;
    }
    return out;
  }

  /**
   * Find this integration's application in the account, or create it.
   *
   * Matched on answer_url === <public base>/answer first. Failing that, an
   * application with this integration's exact app_name is one it created
   * earlier (e.g. before the tunnel URL changed) and its URLs are updated.
   * Any other application is never touched.
   */
  async function ensureApplication(account) {
    const target = answerUrl();
    if (!target) throw Object.assign(new Error("This server has no public URL (TUNNEL_URL) to point Vobiz at"), { status: 500 });
    const base = target.slice(0, -"/answer".length);
    const fields = {
      app_name: APP_NAME,
      answer_url: target,
      answer_method: "POST",
      hangup_url: `${base}/hangup-callback`,
      hangup_method: "POST",
      fallback_answer_url: `${base}/fallback`,
      fallback_method: "POST",
    };

    const apps = await listAll(account, "/Application/", "applications");
    const byUrl = apps.find((a) => a.answer_url === target && idString(a.app_id));
    if (byUrl) return idString(byUrl.app_id);
    const byName = apps.find((a) => a.app_name === APP_NAME && idString(a.app_id));
    if (byName) {
      const id = idString(byName.app_id);
      const u = await vobiz(account, "POST", `/Application/${id}/`, JSON.stringify(fields));
      if (!u.ok) throw Object.assign(new Error(`Vobiz returned ${u.status} updating application ${id}`), { status: 502 });
      console.log(`[provision] repointed this integration's application ${id} in ${account.authId} at ${target}`);
      return id;
    }

    const body = JSON.stringify(fields);
    const r = await vobiz(account, "POST", "/Application/", body);
    const id = r.ok ? idString(r.json && r.json.app_id) : "";
    if (!id) throw Object.assign(new Error(`Vobiz returned ${r.status} creating the application`), { status: 502 });
    console.log(`[provision] created application ${id} in ${account.authId}`);
    return id;
  }

  const randomPassword = () => crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20) + "9a";

  function endpointAppId(json) {
    if (!json) return "";
    const a = json.application;
    if (a && typeof a === "object") return idString(a.app_id);
    return idString(a) || idString(json.app_id);
  }

  /**
   * Bind endpoint -> app. First {"app_id":"<id>"} as a string (what the
   * reference playground sends, and what works in production); verified by
   * GET. If not bound, retry with the documented {"application": <integer>},
   * the validated 17-digit string spliced into the raw JSON text so it is
   * never rounded through a JS number.
   */
  async function bindEndpoint(account, endpointId, appId) {
    if (!/^\d+$/.test(appId)) throw new Error("refusing to bind a non-numeric app id");
    await vobiz(account, "POST", `/Endpoint/${endpointId}/`, JSON.stringify({ app_id: appId }));
    let got = await vobiz(account, "GET", `/Endpoint/${endpointId}/`);
    if (endpointAppId(got.json) === appId) {
      console.log(`[provision] endpoint ${endpointId} bound to application ${appId}`);
      return got;
    }
    await vobiz(account, "POST", `/Endpoint/${endpointId}/`, '{"application":' + appId + "}");
    got = await vobiz(account, "GET", `/Endpoint/${endpointId}/`);
    if (endpointAppId(got.json) === appId) {
      console.log(`[provision] endpoint ${endpointId} bound to application ${appId} (integer "application" retry)`);
    } else {
      console.warn(`[provision] endpoint ${endpointId} is NOT bound to application ${appId} (reads ${endpointAppId(got.json) || "none"}) — outbound calls will not reach this server`);
    }
    return got;
  }

  function usernameFrom(json) {
    if (!json) return "";
    if (json.username) return String(json.username);
    const m = /^sip:([^@]+)@/.exec(String(json.sip_uri || ""));
    return m ? m[1] : "";
  }

  /**
   * One endpoint per (authId, agentId). Returns { endpointId, username, password }.
   */
  async function ensureEndpoint(account, agentId, appId) {
    const key = `${account.authId}:${agentId}`;
    const store = readStore();
    const password = randomPassword();
    let entry = store[key];

    const agentPart = String(agentId).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const alias = `pipedrive-${agentPart || "agent"}`;

    // Not in the local store (new install, or the data dir was wiped): reuse
    // the endpoint this integration created earlier, found by its exact alias.
    if (!entry || !entry.endpointId) {
      const endpoints = await listAll(account, "/Endpoint/", "endpoints");
      const found = endpoints.find((e) => e.alias === alias && idString(e.endpoint_id));
      entry = found ? { endpointId: idString(found.endpoint_id), username: usernameFrom(found) } : null;
    }

    if (entry) {
      const r = await vobiz(account, "POST", `/Endpoint/${entry.endpointId}/`, JSON.stringify({ password }));
      if (r.status === 404) entry = null;
      else if (!r.ok) throw Object.assign(new Error(`Vobiz returned ${r.status} updating the SIP endpoint`), { status: 502 });
    }

    if (!entry) {
      const username = `pd${agentPart}${crypto.randomBytes(4).toString("hex")}`;
      const body = JSON.stringify({ username, password, alias, allow_voice: true, app_id: appId });
      const r = await vobiz(account, "POST", "/Endpoint/", body);
      const endpointId = r.ok ? idString(r.json && r.json.endpoint_id) : "";
      if (!endpointId) throw Object.assign(new Error(`Vobiz returned ${r.status} creating the SIP endpoint`), { status: 502 });
      entry = { endpointId, username: "" };
      console.log(`[provision] created endpoint ${endpointId} for ${key}`);
    }

    // POST /Endpoint/ rewrites the submitted username; the stored one is the
    // truth. Bind (and verify) at the same time.
    const got = await bindEndpoint(account, entry.endpointId, appId);
    const username = usernameFrom(got.json) || entry.username;
    if (!username) throw Object.assign(new Error("Vobiz did not return the endpoint's SIP username"), { status: 502 });

    const fresh = readStore();
    fresh[key] = { endpointId: entry.endpointId, username };
    writeStore(fresh);
    return { endpointId: entry.endpointId, username, password };
  }

  /**
   * Full sign-in. Returns { ok:false, status, error } or
   * { ok:true, account, numbers, sip: { username, password }, callerId }.
   */
  async function signIn(authId, authToken, agentId) {
    let check;
    try {
      check = await verify(authId, authToken);
    } catch (e) {
      return { ok: false, status: 502, error: `Could not reach Vobiz: ${e.message}` };
    }
    if (!check.ok) {
      return { ok: false, status: 401, error: "Vobiz did not accept that Auth ID and Auth Token. Copy both from console.vobiz.ai → API credentials." };
    }

    const existing = accounts.get(authId);
    const account = existing || { authId, authToken, numbers: [], allNumbers: [], numberDetails: [], appId: "" };
    account.authToken = authToken;
    applyNumbers(account, check);
    accounts.set(authId, account);

    try {
      account.appId = await withLock(`app:${authId}`, () => ensureApplication(account));
      const ep = await withLock(`ep:${authId}:${agentId}`, () => ensureEndpoint(account, agentId, account.appId));
      const prev = sipUsers.get(ep.username);
      const callerId = (prev && account.numbers.includes(prev.callerId) && prev.callerId) || account.numbers[0] || "";
      sipUsers.set(ep.username, { authId, agentId, callerId });
      sipDirect.delete(ep.username);
      return { ok: true, account, numbers: account.numbers, numberDetails: account.numberDetails, sip: { username: ep.username, password: ep.password }, callerId };
    } catch (e) {
      console.error(`[provision] ${authId}: ${e.message}`);
      return { ok: false, status: e.status || 502, error: e.message };
    }
  }

  /** Attach a DID to this integration's application, on explicit request only. */
  async function enableInbound(authId, number) {
    const account = accounts.get(authId);
    if (!account || !account.appId) return { ok: false, status: 401, error: "Sign in again" };
    const e164 = normalizeE164(number);
    if (!e164 || !account.numbers.includes(e164)) return { ok: false, status: 400, error: "That number is not on this Vobiz account" };
    const r = await vobiz(account, "POST", `/numbers/${encodeURIComponent(e164)}/application`,
      JSON.stringify({ application_id: account.appId }));
    if (!r.ok) return { ok: false, status: 502, error: `Vobiz returned ${r.status} attaching ${e164}` };
    const detail = (account.numberDetails || []).find((n) => n.e164 === e164);
    const previous = detail ? detail.applicationId : "";
    if (detail) detail.applicationId = account.appId;
    console.log(`[provision] ${e164} now routes to application ${account.appId} in ${authId} (was ${previous || "none"})`);
    return { ok: true, number: e164, applicationId: account.appId, previousApplicationId: previous };
  }

  // ── routing ────────────────────────────────────────────────────────────────
  const sipUserFrom = (from) => {
    const m = /^sip:([^@;>]+)/i.exec(String(from || "").trim().replace(/^</, ""));
    return m ? m[1] : "";
  };

  function bySipUser(user) {
    const s = sipUsers.get(user);
    if (!s) return null;
    const account = accounts.get(s.authId);
    return account ? { ...s, sipUser: user, account } : null;
  }

  function byNumber(number) {
    const e164 = normalizeE164(number);
    if (!e164) return null;
    for (const account of accounts.values()) {
      if ((account.allNumbers || account.numbers).includes(e164)) return account;
    }
    return null;
  }

  function agentsOf(authId) {
    return Array.from(sipUsers.entries()).filter(([, v]) => v.authId === authId).map(([user, v]) => ({ sipUser: user, ...v }));
  }

  function setCallerId(sipUser, number) {
    const s = sipUsers.get(sipUser);
    const account = s && accounts.get(s.authId);
    const e164 = normalizeE164(number);
    if (!account || !account.numbers.includes(e164)) return false;
    s.callerId = e164;
    return true;
  }

  async function refreshNumbers(authId) {
    const account = accounts.get(authId);
    if (!account) return [];
    try {
      const loaded = await loadNumbers(account);
      if (loaded.ok) applyNumbers(account, loaded);
    } catch (e) {
      console.warn("[numbers] could not list account numbers:", e.message);
    }
    return account.numbers;
  }

  // ── SIP direct ─────────────────────────────────────────────────────────────
  const E164 = /^\+[1-9]\d{7,14}$/;

  /**
   * Record which caller ID (and inbound number) a SIP-direct endpoint uses.
   * Nothing here can prove the browser holds the SIP password, so this only
   * ever steers calls the endpoint itself places or that its own DID
   * receives, and it can never take over an endpoint this backend
   * provisioned. Vobiz itself refuses a caller ID the account does not own.
   */
  function claimSipDirect(sipUser, callerId) {
    const user = String(sipUser || "").trim();
    const number = normalizeE164(callerId);
    if (!/^[A-Za-z0-9]{3,64}$/.test(user)) return { ok: false, error: "SIP username must be letters and digits only" };
    if (!E164.test(number)) return { ok: false, error: "Caller ID must be a full phone number with country code" };
    if (sipUsers.has(user)) return { ok: false, error: "That endpoint is managed by a Vobiz account sign-in; use the Vobiz account tab" };
    if (!sipDirect.has(user) && sipDirect.size >= SIP_DIRECT_MAX) {
      const oldest = [...sipDirect.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) sipDirect.delete(oldest[0]);
    }
    const claimToken = crypto.randomBytes(24).toString("hex");
    sipDirect.set(user, { callerId: number, inboundNumber: number, claimToken, at: Date.now() });
    return { ok: true, claimToken, callerId: number };
  }

  function releaseSipDirect(sipUser, claimToken) {
    const entry = sipDirect.get(String(sipUser || ""));
    if (!entry || !claimToken) return false;
    const a = Buffer.from(String(claimToken));
    const b = Buffer.from(entry.claimToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    sipDirect.delete(String(sipUser));
    return true;
  }

  const sipDirectFor = (user) => {
    const e = sipDirect.get(String(user || ""));
    return e ? { sipUser: String(user), callerId: e.callerId, inboundNumber: e.inboundNumber } : null;
  };

  function sipDirectByNumber(number) {
    const e164 = normalizeE164(number);
    if (!e164) return [];
    return [...sipDirect.entries()].filter(([, v]) => v.inboundNumber === e164).map(([user]) => user);
  }

  return {
    signIn,
    claimSipDirect,
    releaseSipDirect,
    sipDirectFor,
    sipDirectByNumber,
    isE164: (v) => E164.test(String(v || "")),
    enableInbound,
    get: (authId) => accounts.get(authId) || null,
    all: () => Array.from(accounts.values()),
    bySipUser,
    byNumber,
    agentsOf,
    setCallerId,
    refreshNumbers,
    sipUserFrom,
    normalizeE164,
    forgetSipUser: (u) => sipUsers.delete(u),
    vobiz,
  };
}

module.exports = { createAccountRegistry, APP_NAME };
