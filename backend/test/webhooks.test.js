const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { startServer, startWithVobiz, fakeApi, login, TOKEN1, TOKEN2 } = require("./harness");

const form = (o) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function signV3(token, url, nonce) {
  return crypto.createHmac("sha256", token).update(`${url}.${nonce}`).digest("base64");
}

/** Sign in and return the SIP user (without @host) the server provisioned. */
async function signedInAgent(base, authId, token, agentId) {
  const { json } = await login(base, authId, token, agentId);
  const sip = await (await fetch(`${base}/api/agent-sip`, { headers: bearer(json.token) })).json();
  return { token: json.token, sipUser: sip.sipUser.split("@")[0] };
}

const answer = (base, params, headers = {}) =>
  fetch(`${base}/answer`, { method: "POST", headers: { ...FORM, ...headers }, body: form(params) }).then((r) => r.text());

test("outbound: each account's browser is routed with that account's caller ID", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const a = await signedInAgent(srv.base, "MA_TEST0001", TOKEN1);
  const b = await signedInAgent(srv.base, "MA_TEST0002", TOKEN2);

  const xa = await answer(srv.base, { From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: "910000000088", RouteType: "sip", CallUUID: "c-out-a" });
  assert.match(xa, /<Dial [^>]*callerId="\+910000000001"/);
  assert.match(xa, /<Number>910000000088<\/Number>/);
  assert.doesNotMatch(xa, /<User>/);
  assert.match(xa, /action="https:\/\/tunnel\.example\.test\/dial-status"/);
  assert.match(xa, /redirect="false"/);
  assert.ok(xa.indexOf("<Record") < xa.indexOf("<Dial"));

  const xb = await answer(srv.base, { From: `sip:${b.sipUser}@registrar.vobiz.ai`, To: "15550100099", RouteType: "sip", CallUUID: "c-out-b" });
  assert.match(xb, /callerId="\+15550100001"/);

  // The header picks among the account's own numbers...
  const xh = await answer(srv.base, { From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: "910000000088", "X-VH-Caller-ID": "+910000000002" });
  assert.match(xh, /callerId="\+910000000002"/);
  // ...and is ignored for someone else's number.
  const xf = await answer(srv.base, { From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: "910000000088", "X-VH-Caller-ID": "+15550100001" });
  assert.match(xf, /callerId="\+910000000001"/);

  // The out-of-band choice is remembered per SIP user.
  await fetch(`${srv.base}/api/caller-id`, { method: "POST", headers: { ...bearer(a.token), "Content-Type": "application/json" }, body: JSON.stringify({ number: "+910000000002" }) });
  assert.match(await answer(srv.base, { From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: "910000000088" }), /callerId="\+910000000002"/);
});

test("outbound: a caller ID that is not a phone number is ignored, not interpolated", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const a = await signedInAgent(srv.base, "MA_TEST0001", TOKEN1);
  const xml = await answer(srv.base, { From: `sip:${a.sipUser}@registrar.vobiz.ai`, To: "910000000088", "X-VH-Caller-ID": '"/><Hangup/><x a="' });
  assert.match(xml, /callerId="\+910000000001"/);
  assert.doesNotMatch(xml, /<Hangup/);
});

test("outbound from a SIP user nobody signed in as gets a polite hangup", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const xml = await answer(srv.base, { From: "sip:stranger@registrar.vobiz.ai", To: "910000000088", RouteType: "sip" });
  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /<Speak>[^<]*sign in[^<]*<\/Speak>\s*<Hangup\/>/i);
});

test("inbound: ParentAuthID picks the account; all its signed-in agents ring", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const a1 = await signedInAgent(srv.base, "MA_TEST0001", TOKEN1, "admin");
  const a2 = await signedInAgent(srv.base, "MA_TEST0001", TOKEN1, "john");
  const b = await signedInAgent(srv.base, "MA_TEST0002", TOKEN2);

  const xml = await answer(srv.base, { From: "910000000099", To: "00000000001", Direction: "inbound", ParentAuthID: "MA_TEST0001", CallUUID: "c-in-1" });
  assert.match(xml, new RegExp(`<User>sip:${a1.sipUser}@registrar\\.vobiz\\.ai</User>`));
  assert.match(xml, new RegExp(`<User>sip:${a2.sipUser}@registrar\\.vobiz\\.ai</User>`));
  assert.ok(!xml.includes(b.sipUser), "rang another account's agent");
  // 0 + 10 digits is a domestic Indian number.
  assert.match(xml, /callerId="\+910000000001"/);

  // Without ParentAuthID the dialled number finds the account.
  const xb = await answer(srv.base, { From: "910000000099", To: "15550100001", Direction: "inbound", CallUUID: "c-in-2" });
  assert.match(xb, new RegExp(`<User>sip:${b.sipUser}@registrar\\.vobiz\\.ai</User>`));
  assert.ok(!xb.includes(a1.sipUser));
  assert.match(xb, /callerId="\+15550100001"/);
});

test("inbound to a number no signed-in account owns: polite hangup and a log line", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const xml = await answer(srv.base, { From: "910000000099", To: "910000000077", Direction: "inbound" });
  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /<Hangup\/>/);
  assert.match(srv.log(), /inbound to 910000000077 .*hanging up/);
});

test("a Hangup event on the answer URL gets an empty response, not a new <Dial>", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const xml = await answer(srv.base, { Event: "Hangup", CallUUID: "x" });
  assert.doesNotMatch(xml, /<Dial/);
});

test("SIP direct: typed endpoint + caller ID route with no account credentials", async (t) => {
  const { srv, stop } = await startWithVobiz();
  t.after(stop);
  const claim = async (body) => {
    const r = await fetch(`${srv.base}/api/sip-direct`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await claim({ sipUser: "deskphone1", callerId: "not a number" })).status, 400);
  assert.equal((await claim({ sipUser: "bad user!", callerId: "+910000000005" })).status, 400);
  const c = await claim({ sipUser: "deskphone1", callerId: "+910000000005" });
  assert.equal(c.status, 200);
  assert.ok(!("token" in c.json), "SIP direct must not get an account session");

  const out = await answer(srv.base, { From: "sip:deskphone1@registrar.vobiz.ai", To: "910000000088", RouteType: "sip", CallUUID: "sd-1" });
  assert.match(out, /callerId="\+910000000005"/);
  assert.match(out, /<Number>910000000088<\/Number>/);
  const hdr = await answer(srv.base, { From: "sip:deskphone1@registrar.vobiz.ai", To: "910000000088", "SIPHeader_X-VH-Caller-ID": "+910000000006" });
  assert.match(hdr, /callerId="\+910000000006"/);

  const inbound = await answer(srv.base, { From: "910000000099", To: "910000000005", Direction: "inbound", CallUUID: "sd-2" });
  assert.match(inbound, /<User>sip:deskphone1@registrar\.vobiz\.ai<\/User>/);
  assert.match(inbound, /callerId="\+910000000005"/);

  // A provisioned (account) endpoint cannot be claimed through SIP direct.
  const a = await signedInAgent(srv.base, "MA_TEST0001", TOKEN1);
  assert.equal((await claim({ sipUser: a.sipUser, callerId: "+910000000005" })).status, 400);

  // Release needs the claim token.
  const rel = (tok) => fetch(`${srv.base}/api/sip-direct/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sipUser: "deskphone1", claimToken: tok }) });
  assert.equal((await rel("nope")).status, 404);
  assert.equal((await rel(c.json.claimToken)).status, 200);
  assert.match(await answer(srv.base, { From: "sip:deskphone1@registrar.vobiz.ai", To: "910000000088", RouteType: "sip" }), /<Hangup\/>/);
});

test("Vobiz signatures are checked with the owning account's token", async (t) => {
  const { srv, stop } = await startWithVobiz();
  const strict = await startWithVobiz({ VOBIZ_WEBHOOK_SIGNATURES: "require" });
  t.after(async () => { await stop(); await strict.stop(); });
  await signedInAgent(srv.base, "MA_TEST0001", TOKEN1);
  await signedInAgent(srv.base, "MA_TEST0002", TOKEN2);
  await signedInAgent(strict.srv.base, "MA_TEST0001", TOKEN1);

  const url = "https://tunnel.example.test/answer";
  const nonce = "12345678901234567890";
  const params = { From: "910000000099", To: "910000000001", ParentAuthID: "MA_TEST0001", Direction: "inbound", CallUUID: "sig-1" };
  const sig = (tok) => ({ "X-Vobiz-Signature-V3": signV3(tok, url, nonce), "X-Vobiz-Signature-V3-Nonce": nonce });
  const post = (base, headers, p = params) => fetch(`${base}/answer`, { method: "POST", headers: { ...FORM, ...headers }, body: form(p) });

  assert.equal((await post(srv.base, sig(TOKEN1))).status, 200);
  // Valid for account 2, but this call belongs to account 1.
  assert.equal((await post(srv.base, sig(TOKEN2))).status, 403);
  assert.equal((await post(srv.base, { "X-Vobiz-Signature-V3": "AAAA", "X-Vobiz-Signature-V3-Nonce": nonce })).status, 403);

  const forgedRecording = await fetch(`${srv.base}/recording-callback`, {
    method: "POST",
    headers: { ...FORM, "X-Vobiz-Signature-V2": "AAAA", "X-Vobiz-Signature-V2-Nonce": nonce },
    body: form({ CallUUID: "x", RecordingID: "r" }),
  });
  assert.equal(forgedRecording.status, 403);

  // Unsigned: allowed in "verify", refused in "require".
  assert.equal((await post(srv.base, {})).status, 200);
  assert.equal((await post(strict.srv.base, {})).status, 403);
  assert.equal((await post(strict.srv.base, sig(TOKEN1))).status, 200);
});

test("recording callback writes a correct Activity and Call Log, with an account-scoped link", async (t) => {
  const pipedrive = await fakeApi((r) => {
    if (r.url.startsWith("/api/v1/persons/find")) return { json: { success: true, data: [{ id: 77, name: "Asha Rao" }] } };
    if (r.url === "/api/v1/activities") return { json: { success: true, data: { id: 501 } } };
    if (r.url === "/api/v1/callLogs") return { json: { success: true, data: { id: "cl-1" } } };
    return null;
  });
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-tok-")), "t.json");
  fs.writeFileSync(store, JSON.stringify({
    access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3, api_domain: pipedrive.url,
  }));
  const { srv, vobiz, stop } = await startWithVobiz({ PIPEDRIVE_TOKEN_STORE: store });
  t.after(async () => { await stop(); await pipedrive.close(); });
  await signedInAgent(srv.base, "MA_TEST0001", TOKEN1);

  await answer(srv.base, { From: "<b>910000000099</b>", To: "910000000001", Direction: "inbound", ParentAuthID: "MA_TEST0001", CallUUID: "call-42" });
  const r = await fetch(`${srv.base}/recording-callback`, {
    method: "POST", headers: FORM,
    body: form({ Event: "RecordStop", CallUUID: "call-42", RecordingID: "rec-42", RecordingDuration: "42" }),
  });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.pipedriveActivity.data.id, 501);
  assert.equal(out.pipedriveCallLog.data.id, "cl-1");

  const activity = JSON.parse(pipedrive.requests.find((x) => x.url === "/api/v1/activities").body);
  assert.equal(activity.type, "call");
  assert.equal(activity.duration, "00:01", "42 s is 00:01 in HH:MM, not 42 minutes");
  assert.equal(activity.person_id, 77);
  assert.doesNotMatch(activity.note, /<b>910000000099<\/b>/, "webhook values must be escaped in the note");
  assert.match(activity.note, /\/recording-file\?authId=MA_TEST0001&amp;recordingId=rec-42&amp;exp=\d+&amp;sig=[0-9a-f]{64}/);

  const callLog = JSON.parse(pipedrive.requests.find((x) => x.url === "/api/v1/callLogs").body);
  for (const k of ["outcome", "to_phone_number", "start_time", "end_time"]) assert.ok(callLog[k], `callLogs.${k} is required`);
  assert.equal(callLog.outcome, "connected");
  assert.equal(callLog.duration, "42");
  assert.match(callLog.start_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(!("to_call_number" in callLog) && !("recording_url" in callLog));

  // The recording was looked up with THIS account's credentials. Its media
  // host is off the allowlist, so nothing was fetched or uploaded.
  const meta = vobiz.requests.find((x) => x.url.includes("/Recording/rec-42/"));
  assert.equal(meta.headers["x-auth-id"], "MA_TEST0001");
  assert.equal(out.pipedriveCallLog.recordingUpload.success, false);
  assert.ok(!pipedrive.requests.some((x) => x.url.includes("/recordings")));
});

test("recording links are account-scoped", async (t) => {
  const { srv, vobiz, stop } = await startWithVobiz();
  t.after(stop);
  vobiz.state.MA_TEST0001.recordings = ["rec-one"];
  vobiz.state.MA_TEST0002.recordings = ["rec-two"];
  const a = await signedInAgent(srv.base, "MA_TEST0001", TOKEN1);
  const b = await signedInAgent(srv.base, "MA_TEST0002", TOKEN2);

  const listA = await (await fetch(`${srv.base}/recordings`, { headers: bearer(a.token) })).json();
  const listB = await (await fetch(`${srv.base}/recordings`, { headers: bearer(b.token) })).json();
  assert.deepEqual(listA.recordings.map((x) => x.recording_id), ["rec-one"]);
  assert.deepEqual(listB.recordings.map((x) => x.recording_id), ["rec-two"]);

  const linkA = new URL(listA.recordings[0].playUrl);
  assert.equal(linkA.searchParams.get("authId"), "MA_TEST0001");
  const local = (u) => `${srv.base}${u.pathname}${u.search}`;

  // Swap the account in a valid link: the signature no longer matches.
  const swapped = new URL(linkA);
  swapped.searchParams.set("authId", "MA_TEST0002");
  assert.equal((await fetch(local(swapped))).status, 403);
  swapped.searchParams.set("recordingId", "rec-two");
  assert.equal((await fetch(local(swapped))).status, 403);

  // The genuine link is accepted and resolved with account 1's credentials.
  const before = vobiz.requests.length;
  const ok = await fetch(local(linkA));
  assert.equal(ok.status, 502, "media host is off the allowlist in the fake");
  const meta = vobiz.requests.slice(before).find((x) => x.url.includes("/Recording/rec-one/"));
  assert.equal(meta.headers["x-auth-id"], "MA_TEST0001");
});

test("recording callback without a CallUUID is refused, not given an invented one", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/recording-callback`, { method: "POST", headers: FORM, body: form({ RecordingID: "r" }) });
  assert.equal(r.status, 400);
});
