const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { startWithVobiz, ADMIN_TOKEN, TOKEN1 } = require("./harness");

const PUBLIC = "https://integrations.example.test/pipedrive";
const ROOT = path.join(__dirname, "..", "..");
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const form = (o) => new URLSearchParams(o).toString();

/**
 * The shared host's proxy: serves the backend under /pipedrive/ and strips the
 * prefix (Caddy `handle_path /pipedrive/*`). Anything outside the prefix is a
 * different backend, so it is recorded and answered 404.
 */
async function strippingProxy(target) {
  const outside = [];
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/pipedrive/")) {
      outside.push(req.url);
      res.writeHead(404);
      return res.end("not this backend");
    }
    const up = http.request({
      host: t.hostname, port: t.port, method: req.method, headers: req.headers,
      path: req.url.slice("/pipedrive".length),
    }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, outside, close: () => new Promise((r) => server.close(r)) };
}

/** The BASE the softphone computes for a page at `pathname`. */
function softphoneBase(pathname) {
  const js = fs.readFileSync(path.join(ROOT, "agent-phone/softphone.js"), "utf8");
  const line = js.split("\n").find((l) => l.includes("const BASE = location.pathname"));
  return vm.runInNewContext(`${line.trim()} BASE`, { location: { pathname } });
}

test("pages build every backend URL from their own path", () => {
  for (const f of ["agent-phone/softphone.js", "agent-phone/vobiz-sip.js", "agent-phone/index.html", "pipedrive-app/pipedrive-cti-app.html"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /fetch\(\s*["'`]\//, `${f}: root-absolute fetch`);
    assert.doesNotMatch(src, /(src|href|action)=["']\/(?!\/)/, `${f}: root-absolute src/href`);
    assert.doesNotMatch(src, /EventSource\(\s*["'`]\//, `${f}: root-absolute EventSource`);
  }
  assert.equal(softphoneBase("/pipedrive/"), "/pipedrive/");
  assert.equal(softphoneBase("/pipedrive/agent-phone/index.html"), "/pipedrive/");
  assert.equal(softphoneBase("/pipedrive/index.html"), "/pipedrive/");
  assert.equal(softphoneBase("/agent-phone/index.html"), "/");
  assert.equal(softphoneBase("/"), "/");
});

test("behind a /pipedrive-stripping proxy: sign-in, calls, recordings, admin cookie and OAuth", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz({
    PUBLIC_BASE_URL: `${PUBLIC}/`,          // trailing slash is tolerated
    TUNNEL_URL: "https://stale-tunnel.example.test", // PUBLIC_BASE_URL wins
  });
  const proxy = await strippingProxy(srv.base);
  t.after(async () => { await proxy.close(); await stop(); });
  const via = (p) => `${proxy.url}/pipedrive${p}`;

  // The softphone loads through the prefix, at both of its addresses.
  for (const p of ["/", "/agent-phone/index.html", "/agent-phone/softphone.js", "/agent-phone/vobiz-sip.js", "/agent-phone/lib/jssip.min.js"]) {
    assert.equal((await fetch(via(p))).status, 200, p);
  }

  // Sign-in and SIP credentials, the way the page calls them (BASE + path).
  const base = softphoneBase("/pipedrive/agent-phone/index.html");
  const login = await fetch(`${proxy.url}${base}api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authId: "MA_TEST0001", authToken: TOKEN1, agentId: "asha" }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const sip = await (await fetch(`${proxy.url}${base.replace(/\/$/, "")}/api/agent-sip`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const sipUser = sip.sipUser.split("@")[0];

  // The Vobiz application points under the prefix.
  assert.equal(vobiz.state.MA_TEST0001.apps[0].answer_url, `${PUBLIC}/answer`);

  // A call: every URL handed to Vobiz carries the prefix.
  const xml = await (await fetch(via("/answer"), {
    method: "POST", headers: FORM,
    body: form({ From: `sip:${sipUser}@registrar.vobiz.ai`, To: "910000000088", RouteType: "sip", CallUUID: "call-p1" }),
  })).text();
  assert.match(xml, new RegExp(`action="${PUBLIC}/dial-status"`));
  assert.match(xml, new RegExp(`callbackUrl="${PUBLIC}/recording-callback"`));

  // Vobiz signs the full public URL, prefix included.
  const nonce = "n1";
  const sig = crypto.createHmac("sha256", TOKEN1).update(`${PUBLIC}/recording-callback.${nonce}`).digest("base64");
  const rec = await fetch(via("/recording-callback"), {
    method: "POST", headers: { ...FORM, "X-Vobiz-Signature-V3": sig, "X-Vobiz-Signature-V3-Nonce": nonce },
    body: form({ CallUUID: "call-p1", RecordingID: "rec-p1", RecordingDuration: "9" }),
  });
  assert.equal(rec.status, 200);

  // Recording links point under the prefix.
  vobiz.state.MA_TEST0001.recordings = ["rec-p1"];
  const list = await (await fetch(via("/recordings?limit=10"), { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(list.recordings[0].playUrl.startsWith(`${PUBLIC}/recording-file?`), list.recordings[0].playUrl);

  // Admin sign-in: the cookie is scoped to /pipedrive, and the next step is relative.
  const session = await fetch(via("/admin/session"), { method: "POST", headers: FORM, redirect: "manual", body: form({ token: ADMIN_TOKEN }) });
  assert.equal(session.status, 303);
  const cookie = session.headers.get("set-cookie");
  assert.match(cookie, /; Path=\/pipedrive;/);
  assert.doesNotMatch(cookie, /Path=\/;/);
  assert.match(cookie, /; Secure/);
  assert.equal(new URL(session.headers.get("location"), via("/admin/session")).pathname, "/pipedrive/auth/pipedrive");

  // OAuth: the redirect URI sent to Pipedrive is under the prefix, and the
  // callback is reachable through it.
  const start = await fetch(via("/auth/pipedrive"), { redirect: "manual", headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.searchParams.get("redirect_uri"), `${PUBLIC}/auth/pipedrive/callback`);
  const cb = await fetch(via(`/auth/pipedrive/callback?error=access_denied`));
  assert.equal(cb.status, 400, "callback route answers under the prefix");

  assert.deepEqual(proxy.outside, [], "no request left /pipedrive/");
});
