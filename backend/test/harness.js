/**
 * Boots the real backend in a child process against local fakes of the Vobiz
 * and Pipedrive APIs. Nothing here touches the network beyond 127.0.0.1, and
 * the server is pointed at a throwaway env file, so a developer's real
 * backend/.env is never read.
 */
const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const SECRET_MARKER = "SECRETMARKER";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A recording HTTP server: every request is kept, and `routes` answers it. */
async function fakeApi(routes = () => null) {
  const requests = [];
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      const out = routes(entry) || { status: 404, json: { error: "not mocked" } };
      res.writeHead(out.status || 200, { "Content-Type": "application/json" });
      res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json || {}));
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-pd-test-")), "test.env");
  fs.writeFileSync(envFile, "# intentionally empty\n");

  const env = {
    PATH: process.env.PATH,
    VOBIZ_ENV_FILE: envFile,
    PORT: String(port),
    VOBIZ_API_URL: "http://127.0.0.1:9",
    DATA_DIR: path.join(path.dirname(envFile), "data"),
    SIGNING_SECRET: `signing_${SECRET_MARKER}`,
    PIPEDRIVE_CLIENT_ID: "client-id",
    PIPEDRIVE_CLIENT_SECRET: `pd_${SECRET_MARKER}`,
    PIPEDRIVE_TOKEN_STORE: path.join(path.dirname(envFile), "tokens.json"),
    TUNNEL_URL: "https://tunnel.example.test",
    ...extraEnv,
  };

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    base,
    env,
    log: () => log,
    stop: () => new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) return r();
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => { clearTimeout(force); r(); });
      child.kill();
    }),
  };
}

/** Raw GET that does not normalise `..` out of the path, like curl --path-as-is. */
function rawGet(base, rawPath, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const TOKEN1 = `auth_token_${SECRET_MARKER}_0001`;
const TOKEN2 = `auth_token_${SECRET_MARKER}_0002`;
const APP_ID_1 = "43919358318796814"; // 17 digits, above Number.MAX_SAFE_INTEGER
const APP_ID_2 = "43919358318796999";

/**
 * A fake of the Vobiz account API for any number of accounts. Each account:
 * { token, numbers: [{ e164, status, voice_enabled, application_id }], appId }.
 *
 * Like the real thing, POST /Endpoint/ rewrites the submitted username (here
 * by appending digits), and app ids are 17-digit strings. `opts.bindWith`
 * chooses which bind body the fake honours: "app_id" (default) or
 * "application" (only the raw integer form).
 */
async function fakeVobiz(accounts, opts = {}) {
  const state = {};
  for (const [authId, a] of Object.entries(accounts)) {
    state[authId] = { ...a, apps: [], endpoints: {}, attached: {}, nextEp: 1000 };
  }
  const api = await fakeApi((r) => {
    const m = /^\/api\/v1\/Account\/([^/]+)(\/.*)$/.exec(r.url);
    if (!m) return null;
    const acct = state[decodeURIComponent(m[1])];
    if (!acct || r.headers["x-auth-id"] !== decodeURIComponent(m[1]) || r.headers["x-auth-token"] !== acct.token) {
      return { status: 401, json: { error: "invalid credentials" } };
    }
    const rest = m[2];
    const u = new URL(rest, "http://x");
    const p = u.pathname;
    if (r.method === "GET" && p === "/numbers") {
      const page = Number(u.searchParams.get("page") || 1);
      const per = Number(u.searchParams.get("per_page") || 20);
      const items = acct.numbers.slice((page - 1) * per, page * per);
      return { json: { items, page, per_page: per, total: acct.numbers.length } };
    }
    if (r.method === "GET" && p === "/Application/") return { json: { objects: acct.apps } };
    if (r.method === "POST" && p === "/Application/") {
      const b = JSON.parse(r.body);
      const app = { ...b, app_id: acct.appId };
      acct.apps.push(app);
      return { status: 201, json: { message: "created", app_id: acct.appId } };
    }
    let mm;
    if (r.method === "POST" && (mm = /^\/Application\/(\d+)\/$/.exec(p))) {
      const app = acct.apps.find((a) => a.app_id === mm[1]);
      Object.assign(app, JSON.parse(r.body));
      return { status: 202, json: {} };
    }
    if (r.method === "GET" && p === "/Endpoint/") return { json: { objects: Object.values(acct.endpoints) } };
    if (r.method === "POST" && p === "/Endpoint/") {
      const b = JSON.parse(r.body);
      const id = String(acct.nextEp++);
      acct.endpoints[id] = { endpoint_id: id, username: `${b.username}${id}`, alias: b.alias, application: null };
      return { status: 201, json: { message: "created", endpoint_id: id } };
    }
    if ((mm = /^\/Endpoint\/(\d+)\/$/.exec(p))) {
      const ep = acct.endpoints[mm[1]];
      if (!ep) return { status: 404, json: {} };
      if (r.method === "GET") {
        // Hand-built so the 17-digit app id is a JSON string, as Vobiz sends it.
        return { raw: JSON.stringify({ ...ep, application: ep.application ? { app_id: ep.application } : null }) };
      }
      const strForm = /"app_id"\s*:\s*"(\d+)"/.exec(r.body);
      const intForm = /"application"\s*:\s*(\d+)/.exec(r.body);
      if ((opts.bindWith || "app_id") === "app_id" && strForm) ep.application = strForm[1];
      if (opts.bindWith === "application" && intForm) ep.application = intForm[1];
      return { status: 202, raw: "" };
    }
    if (r.method === "POST" && (mm = /^\/numbers\/([^/]+)\/application$/.exec(p))) {
      acct.attached[decodeURIComponent(mm[1])] = JSON.parse(r.body).application_id;
      return { json: { message: "Number attached to application" } };
    }
    if (r.method === "GET" && (mm = /^\/Recording\/([^/]+)\/$/.exec(p))) {
      // Off the media allowlist on purpose: the server must stop before
      // fetching it, so the suite never touches the network.
      return { json: { recording_id: mm[1], recording_url: `https://media.invalid/${mm[1]}.mp3` } };
    }
    if (r.method === "GET" && p === "/Recording/") {
      return { json: { objects: (acct.recordings || []).map((id) => ({ recording_id: id, add_time: "2026-01-01", call_uuid: `c-${id}` })) } };
    }
    return null;
  });
  return { ...api, state };
}

const ACCOUNTS = () => ({
  MA_TEST0001: {
    token: TOKEN1, appId: APP_ID_1,
    numbers: [
      { e164: "+910000000001", status: "active", voice_enabled: true, application_id: null },
      { e164: "+910000000002", status: "active", voice_enabled: true, application_id: "12345678901234567" },
      { e164: "+910000000009", status: "inactive", voice_enabled: true, application_id: null },
    ],
  },
  MA_TEST0002: {
    token: TOKEN2, appId: APP_ID_2,
    numbers: [{ e164: "+15550100001", status: "active", voice_enabled: true, application_id: null }],
  },
});

async function login(base, authId = "MA_TEST0001", authToken = TOKEN1, agentId) {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authId, authToken, agentId }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})), text: "" };
}

/** A server backed by a fake multi-account Vobiz. */
async function startWithVobiz(extraEnv = {}, opts = {}) {
  const vobiz = await fakeVobiz(ACCOUNTS(), opts);
  const srv = await startServer({ VOBIZ_API_URL: vobiz.url, ...extraEnv });
  return { srv, vobiz, stop: async () => { await srv.stop(); await vobiz.close(); } };
}

module.exports = {
  startServer, fakeApi, fakeVobiz, startWithVobiz, rawGet, login,
  SECRET_MARKER, TOKEN1, TOKEN2, APP_ID_1, APP_ID_2, ACCOUNTS,
};
