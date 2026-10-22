const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  startServer, startWithVobiz, login, SECRET_MARKER, ADMIN_TOKEN, TOKEN1, TOKEN2, APP_ID_1, APP_ID_2,
} = require("./harness");

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test("sign-in accepts any valid Vobiz account and refuses a wrong token", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);

  // Wrong token for a real account: Vobiz says no, so do we.
  const wrong = await login(srv.base, "MA_TEST0001", "wrong-token-wrong-token");
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /did not accept/);
  // An account Vobiz does not know.
  assert.equal((await login(srv.base, "MA_TEST0404", "a-token")).status, 401);
  assert.equal((await login(srv.base, "", "")).status, 400);

  const one = await login(srv.base, "MA_TEST0001", TOKEN1);
  assert.equal(one.status, 200);
  assert.match(one.json.token, /^[0-9a-f]{64}$/);
  // Only active, voice-enabled numbers are offered as caller IDs.
  assert.deepEqual(one.json.numbers, ["+910000000001", "+910000000002"]);
  assert.equal(one.json.selected, "+910000000001");
  assert.equal(one.json.applicationId, APP_ID_1);

  // A second, different account signs in to the same backend.
  const two = await login(srv.base, "MA_TEST0002", TOKEN2);
  assert.equal(two.status, 200);
  assert.deepEqual(two.json.numbers, ["+15550100001"]);
  assert.equal(two.json.applicationId, APP_ID_2);
});

test("two accounts get distinct endpoints; ids are persisted, secrets are not", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz();
  t.after(stop);

  const a = await login(srv.base, "MA_TEST0001", TOKEN1);
  const b = await login(srv.base, "MA_TEST0002", TOKEN2);
  const sipA = await (await fetch(`${srv.base}/api/agent-sip`, { headers: bearer(a.json.token) })).json();
  const sipB = await (await fetch(`${srv.base}/api/agent-sip`, { headers: bearer(b.json.token) })).json();

  assert.notEqual(sipA.sipUser, sipB.sipUser);
  // Vobiz rewrites the submitted username; the one read back is used.
  const epA = Object.values(vobiz.state.MA_TEST0001.endpoints)[0];
  const epB = Object.values(vobiz.state.MA_TEST0002.endpoints)[0];
  assert.equal(sipA.sipUser, `${epA.username}@registrar.vobiz.ai`);
  assert.equal(sipB.sipUser, `${epB.username}@registrar.vobiz.ai`);
  assert.match(epA.username, /^[A-Za-z0-9]+$/);
  assert.ok(sipA.sipPassword && sipA.sipPassword !== sipB.sipPassword);
  // Each account got this integration's application, pointing at this server.
  assert.equal(vobiz.state.MA_TEST0001.apps[0].answer_url, "https://tunnel.example.test/answer");
  assert.equal(vobiz.state.MA_TEST0002.apps[0].answer_url, "https://tunnel.example.test/answer");

  const store = path.join(srv.env.DATA_DIR, "endpoints.json");
  const saved = fs.readFileSync(store, "utf8");
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(saved)["MA_TEST0001:admin"], { endpointId: epA.endpoint_id, username: epA.username });
  assert.ok(!saved.includes(SECRET_MARKER), "auth token persisted");
  assert.ok(!saved.includes(sipA.sipPassword) && !/password/i.test(saved), "SIP password persisted");

  // Signing in again reuses the endpoint and the application, with a new password.
  const again = await login(srv.base, "MA_TEST0001", TOKEN1);
  const sipA2 = await (await fetch(`${srv.base}/api/agent-sip`, { headers: bearer(again.json.token) })).json();
  assert.equal(Object.keys(vobiz.state.MA_TEST0001.endpoints).length, 1);
  assert.equal(vobiz.state.MA_TEST0001.apps.length, 1);
  assert.equal(sipA2.sipUser, sipA.sipUser);
  assert.notEqual(sipA2.sipPassword, sipA.sipPassword);

  // A different agent profile in the same account gets its own endpoint.
  await login(srv.base, "MA_TEST0001", TOKEN1, "john");
  assert.equal(Object.keys(vobiz.state.MA_TEST0001.endpoints).length, 2);
});

test("the bind request carries the 17-digit app id exactly", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz();
  t.after(stop);
  await login(srv.base, "MA_TEST0001", TOKEN1);
  const binds = vobiz.requests.filter((r) => r.method === "POST" && /\/Endpoint\/\d+\/$/.test(r.url) && /app_id|application/.test(r.body));
  assert.ok(binds.length >= 1);
  assert.equal(binds[0].body, `{"app_id":"${APP_ID_1}"}`);
  assert.equal(Object.values(vobiz.state.MA_TEST0001.endpoints)[0].application, APP_ID_1);
  // Number(APP_ID_1) would have rounded it; prove the test would catch that.
  assert.notEqual(String(Number(APP_ID_1)), APP_ID_1);
});

test("when the app_id string is ignored, the integer form is sent as a raw literal", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz({}, { bindWith: "application" });
  t.after(stop);
  assert.equal((await login(srv.base, "MA_TEST0001", TOKEN1)).status, 200);
  const raw = vobiz.requests.find((r) => r.method === "POST" && /\/Endpoint\/\d+\/$/.test(r.url) && r.body.includes('"application"'));
  assert.equal(raw.body, `{"application":${APP_ID_1}}`);
  assert.equal(Object.values(vobiz.state.MA_TEST0001.endpoints)[0].application, APP_ID_1);
});

test("an application this integration did not create is never repointed", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz();
  t.after(stop);
  vobiz.state.MA_TEST0001.apps.push({ app_id: "11111111111111111", app_name: "Customer IVR", answer_url: "https://customer.example/ivr" });
  await login(srv.base, "MA_TEST0001", TOKEN1);
  const theirs = vobiz.state.MA_TEST0001.apps.find((a) => a.app_id === "11111111111111111");
  assert.equal(theirs.answer_url, "https://customer.example/ivr");
  assert.ok(!vobiz.requests.some((r) => r.url.includes("/Application/11111111111111111/")));
  assert.equal(vobiz.state.MA_TEST0001.apps.length, 2);
});

test("the Auth Token never appears in any HTTP response", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const a = await login(srv.base, "MA_TEST0001", TOKEN1);
  const h = bearer(a.json.token);
  const responses = [
    JSON.stringify(a.json),
    await (await fetch(`${srv.base}/api/session`, { headers: h })).text(),
    await (await fetch(`${srv.base}/api/agent-sip`, { headers: h })).text(),
    await (await fetch(`${srv.base}/numbers`, { headers: h })).text(),
    await (await fetch(`${srv.base}/recordings`, { headers: h })).text(),
    await (await fetch(`${srv.base}/health`)).text(),
    await (await fetch(`${srv.base}/api/inbound/enable`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}" })).text(),
    await (await fetch(`${srv.base}/answer`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "From=910000000099&To=910000000001&ParentAuthID=MA_TEST0001" })).text(),
  ];
  for (const body of responses) assert.ok(!body.includes(SECRET_MARKER), `leaked: ${body.slice(0, 200)}`);
  assert.ok(!srv.log().includes(TOKEN1), "auth token written to the log");
});

test("caller ID and inbound attach only accept the account's own numbers", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz();
  t.after(stop);
  const a = await login(srv.base, "MA_TEST0001", TOKEN1);
  const h = { ...bearer(a.json.token), "Content-Type": "application/json" };

  const foreign = await fetch(`${srv.base}/api/caller-id`, { method: "POST", headers: h, body: JSON.stringify({ number: "+15550100001" }) });
  assert.equal(foreign.status, 400);
  const inactive = await fetch(`${srv.base}/api/caller-id`, { method: "POST", headers: h, body: JSON.stringify({ number: "+910000000009" }) });
  assert.equal(inactive.status, 400);
  const ok = await fetch(`${srv.base}/api/caller-id`, { method: "POST", headers: h, body: JSON.stringify({ number: "+910000000002" }) });
  assert.equal(ok.status, 200);

  // Signing in attaches no number; only the explicit action does.
  assert.deepEqual(vobiz.state.MA_TEST0001.attached, {});
  assert.equal((await fetch(`${srv.base}/api/inbound/enable`, { method: "POST", headers: h, body: JSON.stringify({ number: "+15550100001" }) })).status, 400);
  const en = await fetch(`${srv.base}/api/inbound/enable`, { method: "POST", headers: h, body: JSON.stringify({ number: "+910000000002" }) });
  const enj = await en.json();
  assert.equal(en.status, 200);
  assert.equal(enj.previousApplicationId, "12345678901234567");
  assert.deepEqual(vobiz.state.MA_TEST0001.attached, { "+910000000002": APP_ID_1 });
  const attach = vobiz.requests.find((r) => r.url.endsWith("/numbers/%2B910000000002/application"));
  assert.equal(attach.body, `{"application_id":"${APP_ID_1}"}`);
});

test("SIP credentials only go to a signed-in session", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);

  for (const p of ["/api/agent-sip", "/agent/anyone", "/agent/admin"]) {
    const r = await fetch(srv.base + p);
    const body = await r.text();
    assert.ok(r.status === 401 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!body.includes(SECRET_MARKER) && !/sipPassword/i.test(body), `${p} leaked SIP credentials`);
  }
  const bogus = await fetch(`${srv.base}/api/agent-sip`, { headers: { Authorization: "Bearer deadbeef" } });
  assert.equal(bogus.status, 401);
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
    ["GET", "/api/pipedrive/persons/lookup?phone=%2B15550100000"],
    ["GET", "/sync-recent-cdrs"],
    ["POST", "/sync-recent-cdrs"],
    ["POST", "/hangup-call"],
    ["POST", "/auth/pipedrive/disconnect"],
    ["POST", "/api/caller-id"],
    ["POST", "/api/inbound/enable"],
  ];
  for (const [method, p] of anonymous) {
    const r = await fetch(srv.base + p, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 401, `${method} ${p} -> ${r.status}`);
  }

  for (const p of ["/start-call", "/transfer-call"]) {
    const r = await fetch(srv.base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "+15550100002", target: "+1" }) });
    assert.equal(r.status, 410, `${p} -> ${r.status}`);
  }
});

test("/session no longer reports other agents' sessions", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
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
  for (const qs of [
    "recordingId=abc",
    "authId=MA_TEST0001&recordingId=abc&exp=99999999999&sig=forged",
    "authId=MA_TEST0001&recordingId=abc&exp=1&sig=deadbeef",
  ]) {
    assert.equal((await fetch(`${srv.base}/recording-file?${qs}`)).status, 403, qs);
  }
});

test("connecting Pipedrive requires the admin", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual" });
  assert.equal(r.status, 401);
  const html = await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual", headers: { Accept: "text/html" } });
  assert.equal(html.status, 401);
  assert.match(await html.text(), /href="\.\.\/admin\/login"/, "relative, so it stays under a path prefix");
  assert.equal((await fetch(`${srv.base}/admin/pipedrive/companies`)).status, 401);
  assert.equal((await fetch(`${srv.base}/admin/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "wrong" }),
  })).status, 401);
  // A signed-in Vobiz agent is not the admin either.
  const { json } = await login(srv.base, "MA_TEST0001", TOKEN1).catch(() => ({ json: {} }));
  if (json.token) assert.equal((await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual", headers: { Authorization: `Bearer ${json.token}` } })).status, 401);

  const ok = await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("location"), /\/oauth\/authorize\?/);
});

test("without ADMIN_TOKEN the connect route is off", async (t) => {
  const srv = await startServer({ ADMIN_TOKEN: "" });
  t.after(srv.stop);
  assert.equal((await fetch(`${srv.base}/auth/pipedrive`, { redirect: "manual" })).status, 503);
});
