// Live checks against a RUNNING backend (npm start) and its real services.
// Usage:
//   AUTH_ID=... AUTH_TOKEN=... CALLER_ID=+... node backend/test-pipedrive-sync.js \
//     [--answer] [--inbound] [--recording-proxy] [--sync-cdrs]
//   (or --auth-id / --auth-token / --caller-id flags)
//
// The Vobiz account is supplied at runtime only, from those flags or
// environment variables — never from backend/.env, and there are no defaults.
// Signing in provisions this integration's application and an endpoint in
// that account, exactly as the softphone does.
//
// For the offline suite, which needs no credentials and no network, run
// `npm test`.
//
// Every check reports PASS, FAIL or SKIP, and the process exits non-zero if
// anything failed. SKIP is not a pass: it means a service is not configured.
//
// --inbound writes ONE real Activity and Call Log into the connected Pipedrive
// company, labelled with a test call UUID. Use a sandbox. No check here places
// a phone call.

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const pass = (n, d) => { PASSED++; console.log(`  PASS  ${n}${d ? " — " + d : ""}`); };
const fail = (n, d) => { FAILED++; console.error(`  FAIL  ${n}${d ? " — " + d : ""}`); };
const skip = (n, d) => { SKIPPED++; console.log(`  SKIP  ${n}${d ? " — " + d : ""}`); };

const fs = require("fs");
const path = require("path");
const envFile = process.env.VOBIZ_ENV_FILE || path.join(__dirname, ".env");
try { if (fs.existsSync(envFile)) process.loadEnvFile(envFile); } catch { /* Node < 20.12: use real env vars */ }

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "";
}
const AUTH_ID = arg("--auth-id") || process.env.AUTH_ID || "";
const AUTH_TOKEN = arg("--auth-token") || process.env.AUTH_TOKEN || "";
const CALLER_ID = arg("--caller-id") || process.env.CALLER_ID || "";

const PORT = process.env.PORT || 8092;
const BASE_URL = `http://localhost:${PORT}`;
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

async function signIn() {
  const r = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authId: AUTH_ID, authToken: AUTH_TOKEN }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.token ? j : null;
}

async function main() {
  const args = process.argv.slice(2).filter((a, i, list) => a.startsWith("--") && !["--auth-id", "--auth-token", "--caller-id"].includes(a) && !["--auth-id", "--auth-token", "--caller-id"].includes(list[i - 1]));
  const all = args.length === 0;

  console.log(`\nLive checks against ${BASE_URL}\n`);

  let health;
  try {
    const r = await fetch(`${BASE_URL}/health`);
    health = await r.json();
    if (r.ok && health.status === "ok") pass("backend health");
    else fail("backend health", JSON.stringify(health));
  } catch (err) {
    fail("backend reachable", `${err.message} — is 'npm start' running?`);
    return summarise();
  }

  let token = null;
  let sipUser = "";
  let numbers = [];
  if (!AUTH_ID || !AUTH_TOKEN) {
    skip("sign in", "pass --auth-id and --auth-token (or AUTH_ID / AUTH_TOKEN)");
  } else {
    const session = await signIn();
    if (session) {
      token = session.token;
      numbers = session.numbers || [];
      pass("sign in and provision", `${numbers.length} caller ID(s) on the account`);
    } else {
      fail("sign in", "the server rejected the credentials, or provisioning failed (see the server log)");
    }
  }

  if (token) {
    const r = await fetch(`${BASE_URL}/api/agent-sip`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) { sipUser = (await r.json()).sipUser; pass("SIP identity for the softphone", sipUser); }
    else fail("SIP identity for the softphone", `HTTP ${r.status}`);
  }

  if (all || args.includes("--answer")) {
    // What Vobiz fetches when the browser dials. Must be <Dial><Number>.
    const publicUrl = process.env.TUNNEL_URL || process.env.PUBLIC_BASE_URL;
    if (!publicUrl) {
      skip("public answer URL", "TUNNEL_URL is not set");
    } else if (!sipUser) {
      skip("public answer URL", "not signed in, so there is no SIP user to route");
    } else {
      try {
        const r = await fetch(`${publicUrl.replace(/\/+$/, "")}/answer`, {
          method: "POST", headers: FORM,
          body: new URLSearchParams({ From: `sip:${sipUser}`, To: CALLER_ID || numbers[0] || "", RouteType: "sip" }).toString(),
        });
        const xml = await r.text();
        if (r.ok && /<Dial[^>]*callerId="\+?\d+"[\s\S]*<Number>/.test(xml)) pass("public answer URL returns <Dial><Number>", publicUrl);
        else fail("public answer URL returns <Dial><Number>", `HTTP ${r.status}: ${xml.slice(0, 120)}`);
      } catch (err) {
        fail("public answer URL reachable", err.message);
      }
    }
  }

  if ((all || args.includes("--inbound")) && !(CALLER_ID || numbers[0])) {
    skip("recording callback", "no caller ID: pass --caller-id or sign in to an account with a number");
  } else if (all || args.includes("--inbound")) {
    const callUuid = `live-check-${Date.now()}`;
    try {
      const r = await fetch(`${BASE_URL}/recording-callback`, {
        method: "POST", headers: FORM,
        body: new URLSearchParams({ CallUUID: callUuid, From: "+15550100055", To: CALLER_ID || numbers[0], ParentAuthID: AUTH_ID, RecordingDuration: "42" }).toString(),
      });
      const json = await r.json().catch(() => ({}));
      const activity = json.pipedriveActivity || {};
      const callLog = json.pipedriveCallLog || {};
      if (!r.ok) fail("recording callback", `HTTP ${r.status}${r.status === 403 ? " (signature required — run this against VOBIZ_WEBHOOK_SIGNATURES=verify)" : ""}`);
      else if (activity.mocked) skip("Pipedrive Activity", "ALLOW_MOCK — nothing was written");
      else if (activity.pipedriveConfigured === false) skip("Pipedrive Activity", "Pipedrive not connected — visit /auth/pipedrive");
      else {
        if (activity.success && activity.data && activity.data.id) pass("Pipedrive Activity", `#${activity.data.id}`);
        else fail("Pipedrive Activity", JSON.stringify(activity.error || activity).slice(0, 200));
        if (callLog.success && callLog.data && callLog.data.id) pass("Pipedrive Call Log", callLog.data.id);
        else fail("Pipedrive Call Log", JSON.stringify(callLog.error || callLog).slice(0, 200));
      }
    } catch (err) {
      fail("recording callback", err.message);
    }
  }

  if (all || args.includes("--recording-proxy")) {
    // The security property is the assertion. This endpoint used to fetch any
    // URL a caller named, with the account's Vobiz credentials attached.
    try {
      const r = await fetch(`${BASE_URL}/recording-file?url=${encodeURIComponent("https://example.com/")}`);
      const body = await r.text();
      if (r.ok && /example domain/i.test(body)) fail("recording proxy refuses arbitrary URLs", "fetched an attacker-named host");
      else pass("recording proxy refuses arbitrary URLs", `HTTP ${r.status}`);
    } catch (err) {
      fail("recording proxy refuses arbitrary URLs", err.message);
    }
    for (const [name, qs] of [
      ["unsigned link rejected", "recordingId=abc"],
      ["forged signature rejected", "authId=x&recordingId=abc&exp=99999999999&sig=forged"],
      ["expired signature rejected", "authId=x&recordingId=abc&exp=1&sig=deadbeef"],
    ]) {
      const r = await fetch(`${BASE_URL}/recording-file?${qs}`);
      if (r.status === 403) pass(name); else fail(name, `expected 403, got ${r.status}`);
    }
  }

  if (all || args.includes("--sync-cdrs")) {
    if (!token) {
      skip("CDR sync", "not signed in");
    } else {
      try {
        const r = await fetch(`${BASE_URL}/sync-recent-cdrs`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) fail("CDR sync", `HTTP ${r.status}: ${json.error || ""}`);
        else if (json.mocked) skip("CDR sync", "ALLOW_MOCK — nothing was written");
        else if (json.pipedriveConfigured === false) skip("CDR sync", "Pipedrive not connected — visit /auth/pipedrive");
        else if (typeof json.synced === "number" && json.failed === 0) pass("CDR sync", `${json.synced} of ${json.fetchedCdrs} CDR(s) written`);
        else fail("CDR sync", `${json.failed} failed of ${json.fetchedCdrs}`);
      } catch (err) {
        fail("CDR sync", err.message);
      }
    }
  }

  summarise();
}

function summarise() {
  console.log(`\n  ${PASSED} passed, ${FAILED} failed, ${SKIPPED} skipped`);
  if (SKIPPED) console.log("  Skipped checks are NOT passes — configure the service and re-run.");
  process.exitCode = FAILED > 0 ? 1 : 0;
}

main().catch((err) => { console.error("Live checks crashed:", err); process.exitCode = 1; });
