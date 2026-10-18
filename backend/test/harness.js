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
      res.end(JSON.stringify(out.json || {}));
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
    VOBIZ_AUTH_ID: "MA_TEST0001",
    VOBIZ_AUTH_TOKEN: `auth_token_${SECRET_MARKER}_0123456789`,
    VOBIZ_FROM_NUMBER: "+918000000000",
    VOBIZ_API_URL: "http://127.0.0.1:9",
    VOBIZ_SIP_USER: "pdagenttest",
    VOBIZ_SIP_PASSWORD: `sip_${SECRET_MARKER}`,
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
    stop: () => new Promise((r) => { child.once("exit", r); child.kill(); }),
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

async function login(base, authId = "MA_TEST0001", authToken = `auth_token_${SECRET_MARKER}_0123456789`) {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authId, authToken }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

module.exports = { startServer, fakeApi, rawGet, login, SECRET_MARKER };
