const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer, startWithVobiz, fakeApi, login, pipedriveStore, ADMIN_TOKEN, TOKEN1 } = require("./harness");

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const form = (o) => new URLSearchParams(o).toString();
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function agentsFile(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-agents-")), "agents.json");
  fs.writeFileSync(f, JSON.stringify(content));
  return f;
}

const AGENTS = {
  asha: { name: "Asha Rao", sipUser: "asha@sip.example", pipedriveUserId: 4242, pipedriveEmail: "asha@example.com" },
  ravi: { name: "Ravi K", pipedriveEmail: "ravi@example.com" },
  "bad id!": { name: "Not listed" },
};

/** A connected Pipedrive fake. `deals` answers /persons/77/deals. */
async function connectedPipedrive(deals) {
  const pipedrive = await fakeApi((r) => {
    if (r.url.startsWith("/api/v1/persons/find")) return { json: { success: true, data: [{ id: 77, name: "Asha Customer" }] } };
    if (r.url.startsWith("/api/v1/persons/77/deals")) return { json: { success: true, data: deals } };
    if (r.url === "/api/v1/activities") return { json: { success: true, data: { id: 501 } } };
    if (r.url === "/api/v1/callLogs") return { json: { success: true, data: { id: "cl-1" } } };
    return null;
  });
  const store = pipedriveStore({ 1001: { apiDomain: pipedrive.url } });
  return { pipedrive, store };
}

async function outboundCall(srv, agentId, callUuid) {
  const { json } = await login(srv.base, "MA_TEST0001", TOKEN1, agentId);
  const sip = await (await fetch(`${srv.base}/api/agent-sip`, { headers: bearer(json.token) })).json();
  const sipUser = sip.sipUser.split("@")[0];
  await fetch(`${srv.base}/answer`, {
    method: "POST", headers: FORM,
    body: form({ From: `sip:${sipUser}@registrar.vobiz.ai`, To: "910000000088", RouteType: "sip", CallUUID: callUuid }),
  });
  const r = await fetch(`${srv.base}/recording-callback`, {
    method: "POST", headers: FORM,
    body: form({ CallUUID: callUuid, RecordingID: `rec-${callUuid}`, RecordingDuration: "30" }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

const bodiesFor = (pipedrive, url) => pipedrive.requests.filter((x) => x.url === url).map((x) => JSON.parse(x.body));

test("GET /api/agents lists profile ids and names from agents.json, nothing else", async (t) => {
  const srv = await startServer({ AGENTS_FILE: agentsFile(AGENTS) });
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/api/agents`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body, { agents: [{ id: "asha", name: "Asha Rao" }, { id: "ravi", name: "Ravi K" }] });
  const raw = JSON.stringify(body);
  for (const secret of ["sip.example", "4242", "example.com"]) assert.ok(!raw.includes(secret), `${secret} must not be listed`);
});

test("no agents.json: empty profile list, and a typed profile id still signs in", async (t) => {
  const { srv, stop } = await startWithVobiz({ AGENTS_FILE: path.join(os.tmpdir(), "does-not-exist-agents.json") });
  t.after(stop);
  assert.deepEqual(await (await fetch(`${srv.base}/api/agents`)).json(), { agents: [] });
  const { status, json } = await login(srv.base, "MA_TEST0001", TOKEN1, "new_agent-7");
  assert.equal(status, 200);
  assert.deepEqual(json.agent, { id: "new_agent-7", name: "new_agent-7", email: "" });
});

test("pipedriveUserId owns the agent's Activity and Call Log; without it, no user_id is sent", async (t) => {
  const { pipedrive, store } = await connectedPipedrive([]);
  const { srv, stop } = await startWithVobiz({ PIPEDRIVE_TOKEN_STORE: store, AGENTS_FILE: agentsFile(AGENTS) });
  t.after(async () => { await stop(); await pipedrive.close(); });

  await outboundCall(srv, "asha", "call-asha");
  let [activity] = bodiesFor(pipedrive, "/api/v1/activities");
  let [callLog] = bodiesFor(pipedrive, "/api/v1/callLogs");
  assert.equal(activity.user_id, 4242);
  assert.equal(callLog.user_id, 4242);
  assert.match(activity.note, /Asha Rao/);

  await outboundCall(srv, "ravi", "call-ravi");
  activity = bodiesFor(pipedrive, "/api/v1/activities")[1];
  callLog = bodiesFor(pipedrive, "/api/v1/callLogs")[1];
  assert.ok(!("user_id" in activity), "no pipedriveUserId: Pipedrive picks the owner as before");
  assert.ok(!("user_id" in callLog));
});

test("a call is linked to the contact's deal only when it has exactly one open deal", async (t) => {
  const one = await connectedPipedrive([{ id: 9001, title: "Expansion", status: "open" }]);
  const s1 = await startWithVobiz({ PIPEDRIVE_TOKEN_STORE: one.store });
  t.after(async () => { await s1.stop(); await one.pipedrive.close(); });
  await outboundCall(s1.srv, "asha", "call-deal-1");
  const dealReq = one.pipedrive.requests.find((x) => x.url.startsWith("/api/v1/persons/77/deals"));
  assert.match(dealReq.url, /status=open/);
  assert.equal(bodiesFor(one.pipedrive, "/api/v1/activities")[0].deal_id, 9001);
  assert.equal(bodiesFor(one.pipedrive, "/api/v1/callLogs")[0].deal_id, 9001);

  const two = await connectedPipedrive([{ id: 1, title: "A" }, { id: 2, title: "B" }]);
  const s2 = await startWithVobiz({ PIPEDRIVE_TOKEN_STORE: two.store });
  t.after(async () => { await s2.stop(); await two.pipedrive.close(); });
  await outboundCall(s2.srv, "asha", "call-deal-2");
  assert.ok(!("deal_id" in bodiesFor(two.pipedrive, "/api/v1/activities")[0]), "ambiguous: not linked");
  assert.ok(!("deal_id" in bodiesFor(two.pipedrive, "/api/v1/callLogs")[0]));

  const none = await connectedPipedrive(null);
  const s3 = await startWithVobiz({ PIPEDRIVE_TOKEN_STORE: none.store });
  t.after(async () => { await s3.stop(); await none.pipedrive.close(); });
  await outboundCall(s3.srv, "asha", "call-deal-3");
  assert.ok(!("deal_id" in bodiesFor(none.pipedrive, "/api/v1/activities")[0]));
});

test("Disconnect Pipedrive: an agent disconnects only the company linked to its own account", async (t) => {
  const pipedrive = await fakeApi(() => null);
  const store = pipedriveStore({
    1001: { apiDomain: pipedrive.url, vobizAuthIds: ["MA_TEST0001"] },
    2002: { apiDomain: pipedrive.url },
  });
  const { srv, stop } = await startWithVobiz({ PIPEDRIVE_TOKEN_STORE: store });
  t.after(async () => { await stop(); await pipedrive.close(); });
  const one = await login(srv.base, "MA_TEST0001", TOKEN1, "asha");
  const status = await (await fetch(`${srv.base}/auth/pipedrive/status`, { headers: bearer(one.json.token) })).json();
  assert.equal(status.companyId, "1001");
  assert.equal(status.linked, true);

  const r = await fetch(`${srv.base}/auth/pipedrive/disconnect`, { method: "POST", headers: bearer(one.json.token) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const left = Object.keys(JSON.parse(fs.readFileSync(store, "utf8")));
  assert.deepEqual(left, ["2002"], "the other company is untouched");

  // 2002 is now the default company for MA_TEST0001, but it is not linked to
  // it, so the agent cannot disconnect it. The admin can.
  const again = await fetch(`${srv.base}/auth/pipedrive/disconnect`, { method: "POST", headers: bearer(one.json.token) });
  assert.equal(again.status, 403);
  const admin = await fetch(`${srv.base}/auth/pipedrive/disconnect`, {
    method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: "2002" }),
  });
  assert.equal(admin.status, 200);
  assert.equal((await (await fetch(`${srv.base}/auth/pipedrive/status`)).json()).connected, false);
});

test("panel: no hard-coded profiles, correct call-flow and logging text, a Disconnect Pipedrive control", () => {
  const html = read("agent-phone/index.html");
  const js = read("agent-phone/softphone.js");
  assert.doesNotMatch(html, /<option value="(admin|john|jane)"/);
  assert.doesNotMatch(html, /John Doe|Jane Smith|System Administrator|yourcompany/);
  assert.match(html, /id="loginAgentSelect"[^>]*list="agentProfiles"/, "profile id can be typed or picked");
  assert.match(js, /fetch\(api\("api\/agents"\)\)/);
  assert.doesNotMatch(js, /agentSelect\.value : "admin"/);

  assert.doesNotMatch(html, /dials the customer first/);
  assert.match(html, /Your browser places the call/);
  assert.doesNotMatch(html, /matching contacts and deals/);
  assert.match(html, /exactly one open deal/);

  assert.match(html, /id="pipedriveDisconnectBtn"/);
  assert.match(js, /window\.confirm\(/);
  assert.match(js, /fetch\(api\("auth\/pipedrive\/disconnect"\), \{ method: "POST", headers \}\)/);
});

test("CTI page says the softphone opens in its own tab; PIPEDRIVE_COMPANY_DOMAIN is gone", () => {
  const cti = read("pipedrive-app/pipedrive-cti-app.html");
  assert.match(cti, /opens the softphone in its own browser tab/);
  assert.match(cti, /target="_blank"/);
  for (const f of ["backend/server.js", "backend/.env.example", "README.md"]) {
    assert.doesNotMatch(read(f), /PIPEDRIVE_COMPANY_DOMAIN/, f);
  }
});
