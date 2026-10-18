// Dev tool: list a Vobiz account's recent CDRs and recordings, and optionally
// ask a running backend to sync them to Pipedrive.
//
// Usage:
//   node backend/fetch-cdr.js --auth-id <AUTH_ID> --auth-token <AUTH_TOKEN> [--sync] [--port 8092]
//   AUTH_ID=... AUTH_TOKEN=... node backend/fetch-cdr.js [--sync]
//
// Credentials are taken at runtime only, from the flags or the AUTH_ID /
// AUTH_TOKEN environment variables. Nothing is read from backend/.env and
// there are no defaults: without both values the script stops.

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "";
}

const AUTH_ID = arg("--auth-id") || process.env.AUTH_ID || "";
const AUTH_TOKEN = arg("--auth-token") || process.env.AUTH_TOKEN || "";
const API_URL = arg("--api-url") || process.env.VOBIZ_API_URL || "https://api.vobiz.ai";
const PORT = arg("--port") || process.env.PORT || "8092";

async function main() {
  if (!AUTH_ID || !AUTH_TOKEN) {
    console.error("Usage: node backend/fetch-cdr.js --auth-id <AUTH_ID> --auth-token <AUTH_TOKEN> [--sync]");
    console.error("       (or set AUTH_ID and AUTH_TOKEN in the environment)");
    process.exitCode = 2;
    return;
  }

  const headers = { "X-Auth-ID": AUTH_ID, "X-Auth-Token": AUTH_TOKEN };
  const account = encodeURIComponent(AUTH_ID);
  console.log(`\nFetching Vobiz CDRs and recordings for ${AUTH_ID}\n`);

  console.log("--- Most recent CDRs ---");
  try {
    const cdrRes = await fetch(`${API_URL}/api/v1/Account/${account}/cdr/recent?limit=5`, { headers });
    const cdrJson = await cdrRes.json().catch(() => ({}));
    if (!cdrRes.ok) {
      console.error("CDR fetch failed:", cdrRes.status, cdrJson);
    } else {
      const cdrs = cdrJson.data || [];
      for (const c of cdrs) {
        console.log(
          `- ${c.start_time || "?"} | ${(c.call_direction || "?").padEnd(8)} | ${c.caller_id_number} -> ${c.destination_number} | ` +
          `duration=${c.duration}s | hangup=${c.hangup_cause} | uuid=${c.uuid}`
        );
      }
      if (cdrs.length === 0) console.log("(No CDRs. They appear a few seconds after a call completes.)");
    }
  } catch (err) {
    console.error("CDR fetch network error:", err.message);
  }

  console.log("\n--- Most recent recordings ---");
  try {
    const recRes = await fetch(`${API_URL}/api/v1/Account/${account}/Recording/?limit=5`, { headers });
    const recJson = await recRes.json().catch(() => ({}));
    if (!recRes.ok) {
      console.error("Recording fetch failed:", recRes.status, recJson);
    } else {
      const list = recJson.objects || recJson.data || [];
      for (const r of list) console.log(`- ${r.recording_id || "?"} | call ${r.call_uuid || "?"} | ${r.add_time || ""}`);
      if (list.length === 0) console.log("(No recordings)");
    }
  } catch (err) {
    console.error("Recording fetch network error:", err.message);
  }

  if (process.argv.includes("--sync")) {
    console.log("\n--- Syncing recent CDRs to Pipedrive via the running backend ---");
    try {
      // /sync-recent-cdrs writes to the CRM, so it needs a session. Signing in
      // also provisions this account's application and endpoint if needed.
      const login = await fetch(`http://localhost:${PORT}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authId: AUTH_ID, authToken: AUTH_TOKEN }),
      });
      const session = await login.json().catch(() => ({}));
      if (!login.ok || !session.token) throw new Error(`sign-in failed: ${session.error || login.status}`);
      const res = await fetch(`http://localhost:${PORT}/sync-recent-cdrs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}` },
      });
      console.log(JSON.stringify(await res.json(), null, 2));
    } catch (err) {
      console.error(`Sync failed (is 'npm start' running on port ${PORT}?):`, err.message);
    }
  }
}

main().catch((err) => { console.error("fetch-cdr error:", err); process.exitCode = 1; });
