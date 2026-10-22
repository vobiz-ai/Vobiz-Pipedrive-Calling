const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer, startWithVobiz, fakeApi, login, ADMIN_TOKEN, TOKEN1, TOKEN2 } = require("./harness");

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const form = (o) => new URLSearchParams(o).toString();
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const ADMIN = bearer(ADMIN_TOKEN);

/**
 * One fake for Pipedrive's OAuth server and its API. The code names the
 * company: code "c-1001" yields a token for company 1001.
 */
async function fakePipedrive() {
  const api = await fakeApi((r) => {
    if (r.method === "POST" && r.url === "/oauth/token") {
      const p = new URLSearchParams(r.body);
      const company = p.get("grant_type") === "authorization_code"
        ? p.get("code").replace(/^c-/, "")
        : p.get("refresh_token").replace(/^rt-/, "");
      return { json: { access_token: `at-${company}`, refresh_token: `rt-${company}`, expires_in: 3600, api_domain: api.url, scope: "base" } };
    }
    const company = String(r.headers.authorization || "").replace(/^Bearer at-/, "");
    if (r.url === "/api/v1/users/me") {
      return { json: { success: true, data: { company_id: Number(company), company_domain: `co${company}` } } };
    }
    if (r.url.startsWith("/api/v1/persons/find")) return { json: { success: true, data: [{ id: 77, name: `Contact of ${company}` }] } };
    if (r.url === "/api/v1/activities") return { json: { success: true, data: { id: Number(company) } } };
    if (r.url === "/api/v1/callLogs") return { json: { success: true, data: { id: `cl-${company}` } } };
    return null;
  });
  return api;
}

/** Run the admin's connect flow for `code`, optionally linking a Vobiz account. */
async function connect(srv, code, authId) {
  const start = await fetch(`${srv.base}/auth/pipedrive${authId ? `?authId=${authId}` : ""}`, { redirect: "manual", headers: ADMIN });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cb = await fetch(`${srv.base}/auth/pipedrive/callback?code=${code}&state=${state}`);
  assert.equal(cb.status, 200, await cb.clone().text());
  return cb.text();
}

async function inboundCallLogged(srv, authId, did, callUuid) {
  await fetch(`${srv.base}/answer`, {
    method: "POST", headers: FORM,
    body: form({ From: "910000000099", To: did, ParentAuthID: authId, CallUUID: callUuid }),
  });
  const r = await fetch(`${srv.base}/recording-callback`, {
    method: "POST", headers: FORM,
    body: form({ CallUUID: callUuid, RecordingDuration: "5" }),
  });
  return r.json();
}

test("two companies coexist across a restart, each logging only its own account's calls", async (t) => {
  const pd = await fakePipedrive();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-data-"));
  const store = path.join(dataDir, "pipedrive-companies.json");
  const env = { PIPEDRIVE_OAUTH_URL: pd.url, PIPEDRIVE_TOKEN_STORE: store };
  t.after(() => pd.close());

  let s = await startWithVobiz(env);
  assert.match(await connect(s.srv, "c-1001", "MA_TEST0001"), /linked to Vobiz account MA_TEST0001/);
  await connect(s.srv, "c-2002", "MA_TEST0002");
  const list = await (await fetch(`${s.srv.base}/admin/pipedrive/companies`, { headers: ADMIN })).json();
  assert.deepEqual(list.companies.map((c) => [c.companyId, c.vobizAuthIds]).sort(), [["1001", ["MA_TEST0001"]], ["2002", ["MA_TEST0002"]]]);
  assert.ok(!JSON.stringify(list).includes("rt-"), "no token in the listing");

  // Nothing on disk in the clear.
  const raw = fs.readFileSync(store, "utf8");
  assert.doesNotMatch(raw, /at-1001|rt-1001|at-2002|rt-2002/);
  assert.match(raw, /"refreshToken": "v1:/);
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  await s.stop();

  // Restart: same store, both companies still there.
  s = await startWithVobiz(env);
  t.after(() => s.stop());
  await login(s.srv.base, "MA_TEST0001", TOKEN1, "a");
  await login(s.srv.base, "MA_TEST0002", TOKEN2, "b");
  const one = await inboundCallLogged(s.srv, "MA_TEST0001", "910000000001", "call-c1");
  const two = await inboundCallLogged(s.srv, "MA_TEST0002", "15550100001", "call-c2");
  assert.equal(one.pipedriveActivity.data.id, 1001);
  assert.equal(two.pipedriveActivity.data.id, 2002);
  const activityAuth = pd.requests.filter((r) => r.url === "/api/v1/activities").map((r) => r.headers.authorization);
  assert.deepEqual(activityAuth, ["Bearer at-1001", "Bearer at-2002"]);
});

test("re-connecting a company keeps it one record; an expired token is refreshed and re-sealed", async (t) => {
  const pd = await fakePipedrive();
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-data-")), "c.json");
  const s = await startWithVobiz({ PIPEDRIVE_OAUTH_URL: pd.url, PIPEDRIVE_TOKEN_STORE: store });
  t.after(async () => { await s.stop(); await pd.close(); });
  await connect(s.srv, "c-1001", "MA_TEST0001");
  await connect(s.srv, "c-1001");
  const saved = JSON.parse(fs.readFileSync(store, "utf8"));
  assert.deepEqual(Object.keys(saved), ["1001"]);
  assert.deepEqual(saved["1001"].vobizAuthIds, ["MA_TEST0001"], "links survive a re-connect");

  // Force expiry on disk; the next CRM call refreshes.
  saved["1001"].expiresAt = 1;
  fs.writeFileSync(store, JSON.stringify(saved));
  await login(s.srv.base, "MA_TEST0001", TOKEN1, "a");
  await inboundCallLogged(s.srv, "MA_TEST0001", "910000000001", "call-r1");
  assert.ok(pd.requests.some((r) => r.url === "/oauth/token" && r.body.includes("grant_type=refresh_token")));
  const after = JSON.parse(fs.readFileSync(store, "utf8"))["1001"];
  assert.ok(after.expiresAt > Date.now());
  assert.match(after.accessToken, /^v1:/);
});

test("an account no company claims is not logged to another account's company", async (t) => {
  const pd = await fakePipedrive();
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-data-")), "c.json");
  const s = await startWithVobiz({ PIPEDRIVE_OAUTH_URL: pd.url, PIPEDRIVE_TOKEN_STORE: store });
  t.after(async () => { await s.stop(); await pd.close(); });
  await connect(s.srv, "c-1001", "MA_TEST0001");
  await login(s.srv.base, "MA_TEST0002", TOKEN2, "b");
  const out = await inboundCallLogged(s.srv, "MA_TEST0002", "15550100001", "call-x");
  assert.equal(out.pipedriveActivity.pipedriveConfigured, false);
  assert.ok(!pd.requests.some((r) => r.url === "/api/v1/activities"));
});

test("a plaintext token file from an older version is sealed into the store and deleted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-legacy-"));
  const legacy = path.join(dir, ".pipedrive-tokens.json");
  fs.writeFileSync(legacy, JSON.stringify({ access_token: "old-at", refresh_token: "old-rt", expires_at: Date.now() + 3600e3, api_domain: "https://x.pipedrive.com" }));
  const store = path.join(dir, "companies.json");
  const srv = await startServer({ PIPEDRIVE_LEGACY_TOKEN_FILE: legacy, PIPEDRIVE_TOKEN_STORE: store });
  t.after(srv.stop);
  assert.ok(!fs.existsSync(legacy), "plaintext file removed");
  const raw = fs.readFileSync(store, "utf8");
  assert.doesNotMatch(raw, /old-at|old-rt/);
  assert.equal((await (await fetch(`${srv.base}/auth/pipedrive/status`)).json()).connected, true);
});

test("without TOKEN_ENCRYPTION_KEY no grant is stored", async (t) => {
  const srv = await startServer({ TOKEN_ENCRYPTION_KEY: "" });
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual", headers: ADMIN });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /TOKEN_ENCRYPTION_KEY/);
});

test("admin links an account to a company; the admin sign-in form sets a cookie that works for the connect", async (t) => {
  const pd = await fakePipedrive();
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-data-")), "c.json");
  const s = await startWithVobiz({ PIPEDRIVE_OAUTH_URL: pd.url, PIPEDRIVE_TOKEN_STORE: store });
  t.after(async () => { await s.stop(); await pd.close(); });

  const signIn = await fetch(`${s.srv.base}/admin/session`, {
    method: "POST", headers: FORM, redirect: "manual", body: form({ token: ADMIN_TOKEN, authId: "MA_TEST0002" }),
  });
  assert.equal(signIn.status, 303);
  assert.equal(signIn.headers.get("location"), "../auth/pipedrive?authId=MA_TEST0002");
  const cookie = signIn.headers.get("set-cookie").split(";")[0];
  const start = await fetch(`${s.srv.base}/auth/pipedrive?authId=MA_TEST0002`, { redirect: "manual", headers: { Cookie: cookie } });
  assert.equal(start.status, 302);
  // A tampered cookie is not admin.
  const bad = await fetch(`${s.srv.base}/auth/pipedrive`, { redirect: "manual", headers: { Cookie: cookie.replace(/.$/, "x") } });
  assert.equal(bad.status, 401);

  await connect(s.srv, "c-1001");
  const r = await fetch(`${s.srv.base}/admin/pipedrive/link`, {
    method: "POST", headers: { ...ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: "1001", authId: "MA_TEST0001" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).company.vobizAuthIds, ["MA_TEST0001"]);
});
