// CLI Tool to fetch live VoBiz CDRs and Call Recordings and sync them to Pipedrive
// Usage: node backend/fetch-cdr.js [--sync]

const fs = require("fs");
const path = require("path");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx !== -1 && !line.trim().startsWith("#")) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (key) process.env[key] = val;
      }
    }
  }
}

const { VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_API_URL = "https://api.vobiz.ai", PORT = 8092 } = process.env;

async function main() {
  console.log(`\n==================================================`);
  console.log(`📡 Fetching VoBiz CDRs & Recordings for ${VOBIZ_AUTH_ID || "Account"}`);
  console.log(`==================================================`);

  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN || VOBIZ_AUTH_ID.includes("YOUR_")) {
    console.error("❌ VoBiz API credentials (VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN) not configured in backend/.env");
    console.log("ℹ️  Running in demonstration mode.");
  }

  const headers = {
    "X-Auth-ID": VOBIZ_AUTH_ID || "",
    "X-Auth-Token": VOBIZ_AUTH_TOKEN || ""
  };

  console.log(`\n--- Most Recent CDRs (Call Detail Records) ---`);
  try {
    if (VOBIZ_AUTH_ID && !VOBIZ_AUTH_ID.includes("YOUR_")) {
      const cdrRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/cdr/recent?limit=5`, { headers });
      const cdrJson = await cdrRes.json();
      if (!cdrRes.ok) {
        console.error("❌ CDR fetch failed:", cdrRes.status, cdrJson);
      } else {
        const cdrs = cdrJson.data || [];
        for (const c of cdrs) {
          console.log(
            `- ${c.start_time || "Now"} | ${(c.call_direction || "outbound").padEnd(8)} | ${c.caller_id_number} -> ${c.destination_number} | ` +
            `duration=${c.duration}s | hangup=${c.hangup_cause} | uuid=${c.uuid}`
          );
        }
        if (cdrs.length === 0) {
          console.log("(No CDRs found. Note: CDRs appear a few seconds after a call completes)");
        }
      }
    } else {
      console.log("- [Mock CDR] 2026-09-02T12:00:00Z | outbound | +15550100000 -> +15550192834 | duration=45s | hangup=NORMAL_CLEARING | uuid=mock-cdr-101");
    }
  } catch (err) {
    console.error("❌ CDR fetch network error:", err.message);
  }

  console.log(`\n--- Most Recent Call Recordings ---`);
  try {
    if (VOBIZ_AUTH_ID && !VOBIZ_AUTH_ID.includes("YOUR_")) {
      const recRes = await fetch(`${VOBIZ_API_URL}/api/v1/Account/${VOBIZ_AUTH_ID}/Recording/?limit=5`, { headers });
      const recJson = await recRes.json();
      if (!recRes.ok) {
        console.error("❌ Recording fetch failed:", recRes.status, recJson);
      } else {
        const list = recJson.data || recJson.recordings || [];
        for (const r of list) {
          console.log(`- UUID: ${r.call_uuid || r.uuid || "N/A"} | URL: ${r.record_url || r.recording_url || r.url || "N/A"}`);
        }
        if (list.length === 0) {
          console.log("(No recordings found)");
        }
      }
    } else {
      console.log("- [Mock Recording] UUID: mock-cdr-101 | URL: https://media.vobiz.ai/v1/recording/mock-recording-101.mp3");
    }
  } catch (err) {
    console.error("❌ Recording fetch network error:", err.message);
  }

  if (process.argv.includes("--sync")) {
    console.log(`\n==================================================`);
    console.log(`🔄 Triggering Pipedrive CDR & Recording Synchronization`);
    console.log(`==================================================`);
    try {
      // /sync-recent-cdrs writes to the CRM, so it needs a session like any
      // other caller. Sign in with the same credentials the server holds.
      const login = await fetch(`http://localhost:${PORT}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authId: VOBIZ_AUTH_ID, authToken: VOBIZ_AUTH_TOKEN }),
      });
      const session = await login.json().catch(() => ({}));
      if (!login.ok || !session.token) throw new Error(`sign-in failed: ${session.error || login.status}`);
      const res = await fetch(`http://localhost:${PORT}/sync-recent-cdrs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const syncJson = await res.json();
      console.log(JSON.stringify(syncJson, null, 2));
    } catch (err) {
      console.error("❌ Sync trigger failed (Is 'npm start' running on port " + PORT + "?):", err.message);
    }
  }
}

main().catch((err) => console.error("fetch-cdr error:", err));
