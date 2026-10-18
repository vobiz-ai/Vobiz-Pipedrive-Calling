const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, fakeApi, login, SECRET_MARKER } = require("./harness");

test("sign-in requires this server's exact Auth ID and Auth Token", async (t) => {
  // A fake Vobiz that says yes to everything: sign-in must not depend on it.
  const vobiz = await fakeApi(() => ({ status: 200, json: { items: [{ e164: "+918000000001" }] } }));
  const srv = await startServer({ VOBIZ_API_URL: vobiz.url, ALLOW_MOCK: "1" });
  t.after(async () => { await srv.stop(); await vobiz.close(); });

  // Regression: the right Auth ID with any token used to sign in.
  assert.equal((await login(srv.base, "MA_TEST0001", "wrong-token-wrong-token")).status, 401);
  // A pair valid for some other account must not unlock this server's SIP credentials.
  assert.equal((await login(srv.base, "MA_OTHER001", "a-token-for-another-account")).status, 401);
  // Regression: the old fallback accepted any 6 + 16 characters.
  assert.equal((await login(srv.base, "abcdef", "abcdefghijklmnop")).status, 401);
  assert.equal((await login(srv.base, "", "")).status, 400);

  const ok = await login(srv.base);
  assert.equal(ok.status, 200);
  assert.match(ok.json.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(ok.json.numbers, ["+918000000001"]);
  assert.ok(!JSON.stringify(ok.json).includes(SECRET_MARKER), "sign-in response must not echo secrets");
});

test("SIP credentials only go to a signed-in session", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  for (const p of ["/api/agent-sip", "/agent/anyone", "/agent/admin"]) {
    const r = await fetch(srv.base + p);
    const body = await r.text();
    assert.ok(r.status === 401 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!body.includes(SECRET_MARKER) && !/sipPassword/i.test(body), `${p} leaked SIP credentials`);
  }
  const bogus = await fetch(`${srv.base}/api/agent-sip`, { headers: { Authorization: "Bearer deadbeef" } });
  assert.equal(bogus.status, 401);

  const { json } = await login(srv.base);
  const r = await fetch(`${srv.base}/api/agent-sip`, { headers: { Authorization: `Bearer ${json.token}` } });
  assert.equal(r.status, 200);
  const creds = await r.json();
  assert.equal(creds.sipUser, "pdagenttest@registrar.vobiz.ai");
});

test("routes that spend money or read CRM data refuse anonymous callers", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const anonymous = [
    ["GET", "/recordings"],
    ["GET", "/play-recording?callUuid=x"],
    ["GET", "/recording-info"],
    ["GET", "/api/recording-info"],
    ["GET", "/numbers"],
    ["GET", "/api/pipedrive/persons/lookup?phone=%2B15550000000"],
    ["GET", "/sync-recent-cdrs"],
    ["POST", "/sync-recent-cdrs"],
    ["POST", "/hangup-call"],
    ["POST", "/auth/pipedrive/disconnect"],
  ];
  for (const [method, p] of anonymous) {
    const r = await fetch(srv.base + p, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 401, `${method} ${p} -> ${r.status}`);
  }

  // Unauthenticated REST origination billed to the account, and a transfer
  // that reported success while doing nothing. Both are gone.
  for (const p of ["/start-call", "/transfer-call"]) {
    const r = await fetch(srv.base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "+15550192834", target: "+1" }) });
    assert.equal(r.status, 410, `${p} -> ${r.status}`);
  }
});

test("/session no longer reports other agents' sessions", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  await login(srv.base);
  const r = await fetch(`${srv.base}/session/admin`);
  const body = await r.text();
  assert.ok(!body.includes("MA_TEST0001"), "leaked the signed-in Auth ID");
  const anon = await (await fetch(`${srv.base}/session`)).json();
  assert.equal(anon.loggedIn, false);
});

test("/health reports booleans, not credential prefixes", async (t) => {
  const srv = await startServer({ PIPEDRIVE_API_TOKEN: `pdtoken_${SECRET_MARKER}` });
  t.after(srv.stop);
  const body = await (await fetch(`${srv.base}/health`)).text();
  assert.ok(!body.includes("MA_TES"), body);
  assert.ok(!body.includes("pdtoke"), body);
});

test("CORS reflects only allow-listed origins", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const evil = await fetch(`${srv.base}/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(`${srv.base}/api/login`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  const pd = await fetch(`${srv.base}/health`, { headers: { Origin: "https://acme.pipedrive.com" } });
  assert.equal(pd.headers.get("access-control-allow-origin"), "https://acme.pipedrive.com");
});

test("recording proxy takes no caller-supplied URL", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/recording-file?url=${encodeURIComponent("https://example.com/")}`);
  assert.equal(r.status, 400);
  for (const qs of ["recordingId=abc", "recordingId=abc&exp=99999999999&sig=forged", "recordingId=abc&exp=1&sig=deadbeef"]) {
    assert.equal((await fetch(`${srv.base}/recording-file?${qs}`)).status, 403, qs);
  }
});

test("Pipedrive cannot be re-pointed at another company while connected", async (t) => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-tok-")), "t.json");
  fs.writeFileSync(store, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600e3 }));
  const srv = await startServer({ PIPEDRIVE_TOKEN_STORE: store });
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual" });
  assert.equal(r.status, 409);
});
