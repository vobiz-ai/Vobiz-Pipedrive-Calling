const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { startServer, fakeApi } = require("./harness");

const form = (o) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const TOKEN = "auth_token_SECRETMARKER_0123456789";

function signV3(url, nonce) {
  return crypto.createHmac("sha256", TOKEN).update(`${url}.${nonce}`).digest("base64");
}

test("outbound: the browser is the A leg and gets <Dial><Number> with the picked caller ID", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const xml = await (await fetch(`${srv.base}/answer`, {
    method: "POST",
    headers: FORM,
    body: form({
      From: "sip:pdagenttest@registrar.vobiz.ai", To: "919876543210", RouteType: "sip",
      CallUUID: "c-out-1", "X-VH-Caller-ID": "+918000000002",
    }),
  })).text();
  assert.match(xml, /<Dial [^>]*callerId="\+918000000002"/);
  assert.match(xml, /<Number>919876543210<\/Number>/);
  assert.doesNotMatch(xml, /<User>/);
  assert.match(xml, /action="https:\/\/tunnel\.example\.test\/dial-status"/);
  assert.match(xml, /redirect="false"/);
  // <Record> is a sibling before <Dial>, never nested inside it.
  assert.ok(xml.indexOf("<Record") < xml.indexOf("<Dial"));
});

test("outbound: a caller ID that is not a phone number is ignored, not interpolated", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const xml = await (await fetch(`${srv.base}/answer`, {
    method: "POST",
    headers: FORM,
    body: form({ From: "sip:pdagenttest@registrar.vobiz.ai", To: "919876543210", "X-VH-Caller-ID": '"/><Hangup/><x a="' }),
  })).text();
  assert.match(xml, /callerId="\+918000000000"/);
  assert.doesNotMatch(xml, /<Hangup/);
});

test("inbound: <Dial><User> to the registered endpoint, callerId is the dialled DID", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const xml = await (await fetch(`${srv.base}/answer`, {
    method: "POST",
    headers: FORM,
    body: form({ From: "919999999999", To: "918000000003", CallUUID: "c-in-1", Direction: "inbound" }),
  })).text();
  assert.match(xml, /<User>sip:pdagenttest@registrar\.vobiz\.ai<\/User>/);
  assert.match(xml, /callerId="\+918000000003"/);
});

test("a Hangup event on the answer URL gets an empty response, not a new <Dial>", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const xml = await (await fetch(`${srv.base}/answer`, { method: "POST", headers: FORM, body: form({ Event: "Hangup", CallUUID: "x" }) })).text();
  assert.doesNotMatch(xml, /<Dial/);
});

test("Vobiz signatures: valid accepted, forged rejected, unsigned per mode", async (t) => {
  const srv = await startServer();
  const strict = await startServer({ VOBIZ_WEBHOOK_SIGNATURES: "require" });
  t.after(async () => { await srv.stop(); await strict.stop(); });

  const url = "https://tunnel.example.test/answer";
  const nonce = "12345678901234567890";
  const body = form({ From: "919999999999", To: "918000000003", CallUUID: "sig-1" });

  const good = await fetch(`${srv.base}/answer?agentId=admin`, {
    method: "POST",
    headers: { ...FORM, "X-Vobiz-Signature-V3": signV3(url, nonce), "X-Vobiz-Signature-V3-Nonce": nonce },
    body,
  });
  assert.equal(good.status, 200);

  const forged = await fetch(`${srv.base}/answer`, {
    method: "POST",
    headers: { ...FORM, "X-Vobiz-Signature-V3": "AAAA", "X-Vobiz-Signature-V3-Nonce": nonce },
    body,
  });
  assert.equal(forged.status, 403);

  const forgedRecording = await fetch(`${srv.base}/recording-callback`, {
    method: "POST",
    headers: { ...FORM, "X-Vobiz-Signature-V2": "AAAA", "X-Vobiz-Signature-V2-Nonce": nonce },
    body: form({ CallUUID: "x", RecordingID: "r" }),
  });
  assert.equal(forgedRecording.status, 403);

  assert.equal((await fetch(`${srv.base}/answer`, { method: "POST", headers: FORM, body })).status, 200);
  assert.equal((await fetch(`${strict.base}/answer`, { method: "POST", headers: FORM, body })).status, 403);
  const strictGood = await fetch(`${strict.base}/answer`, {
    method: "POST",
    headers: { ...FORM, "X-Vobiz-Signature-V3": signV3(url, nonce), "X-Vobiz-Signature-V3-Nonce": nonce },
    body,
  });
  assert.equal(strictGood.status, 200);
});

test("recording callback writes a correct Activity and Call Log to Pipedrive", async (t) => {
  const pipedrive = await fakeApi((r) => {
    if (r.url.startsWith("/api/v1/persons/find")) return { json: { success: true, data: [{ id: 77, name: "Asha Rao" }] } };
    if (r.url === "/api/v1/activities") return { json: { success: true, data: { id: 501 } } };
    if (r.url === "/api/v1/callLogs") return { json: { success: true, data: { id: "cl-1" } } };
    return null;
  });
  const vobiz = await fakeApi(() => ({ status: 404, json: {} }));
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-tok-")), "t.json");
  fs.writeFileSync(store, JSON.stringify({
    access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3, api_domain: pipedrive.url,
  }));
  const srv = await startServer({ PIPEDRIVE_TOKEN_STORE: store, VOBIZ_API_URL: vobiz.url });
  t.after(async () => { await srv.stop(); await pipedrive.close(); await vobiz.close(); });

  // The call is answered first, so the server knows the direction.
  await fetch(`${srv.base}/answer`, {
    method: "POST", headers: FORM,
    body: form({ From: "<b>919999999999</b>", To: "918000000003", CallUUID: "call-42" }),
  });
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
  assert.doesNotMatch(activity.note, /<b>919999999999<\/b>/, "webhook values must be escaped in the note");
  assert.match(activity.note, /\/recording-file\?recordingId=rec-42&amp;exp=\d+&amp;sig=[0-9a-f]{64}/);

  const callLog = JSON.parse(pipedrive.requests.find((x) => x.url === "/api/v1/callLogs").body);
  for (const k of ["outcome", "to_phone_number", "start_time", "end_time"]) assert.ok(callLog[k], `callLogs.${k} is required`);
  assert.equal(callLog.outcome, "connected");
  assert.equal(callLog.duration, "42");
  assert.match(callLog.start_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(!("to_call_number" in callLog) && !("recording_url" in callLog));

  // The recording could not be fetched (the fake Vobiz has none), so no upload
  // was attempted and nothing pretended otherwise.
  assert.equal(out.pipedriveCallLog.recordingUpload.success, false);
  assert.ok(!pipedrive.requests.some((x) => x.url.includes("/recordings")));
});

test("recording callback without a CallUUID is refused, not given an invented one", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const r = await fetch(`${srv.base}/recording-callback`, { method: "POST", headers: FORM, body: form({ RecordingID: "r" }) });
  assert.equal(r.status, 400);
});
