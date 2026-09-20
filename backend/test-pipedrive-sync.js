// Integration Test Suite for VoBiz to Pipedrive CRM Integration
// Usage: node backend/test-pipedrive-sync.js [--mock-outbound] [--mock-inbound] [--recording-proxy] [--sync-cdrs]


/*
 * Every check below reports PASS, FAIL, or SKIP — and the process exits
 * non-zero if anything failed.
 *
 * It used to print a green tick for all four suites regardless of what
 * happened: an outbound call that Vobiz rejected with HTTP 400 was reported as
 * "Outbound call initiated successfully", CRM syncs that never left the process
 * were reported as synced, and 24 bytes of a hardcoded fake MP3 header were
 * reported as streamed audio. A suite that cannot fail is not a test.
 */
let PASSED = 0, FAILED = 0, SKIPPED = 0;

function pass(name, detail) {
  PASSED++;
  console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
}
function fail(name, detail) {
  FAILED++;
  console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
}
function skip(name, why) {
  SKIPPED++;
  console.log(`  SKIP  ${name}${why ? " — " + why : ""}`);
}

function summarise() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${PASSED} passed, ${FAILED} failed, ${SKIPPED} skipped`);
  if (SKIPPED) console.log("  Skipped checks are NOT passes — configure the service and re-run.");
  console.log(`${"=".repeat(50)}\n`);
  process.exitCode = FAILED > 0 ? 1 : 0;
}

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

const PORT = process.env.PORT || 8092;
const BASE_URL = `http://localhost:${PORT}`;

async function runTests() {
  const args = process.argv.slice(2);
  const runAll = args.length === 0;

  console.log(`\n==================================================`);
  console.log(`🧪 Running VoBiz Pipedrive Integration Test Suite`);
  console.log(`==================================================`);

  // 1. Health Check Test
  console.log(`\n[Test 1] Checking Backend Health...`);
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const json = await res.json();
    if (res.ok && json.status === "ok") {
      pass("backend health", `port ${PORT}`);
    } else {
      console.error(`❌ Health check failed:`, json);
    }
  } catch (err) {
    console.error(`❌ Server is not reachable at ${BASE_URL}. Ensure 'npm start' is running! Error:`, err.message);
    process.exit(1);
  }

  // 2. Outbound Call Test
  if (runAll || args.includes("--mock-outbound")) {
    console.log(`\n[outbound] POST /start-call`);
    try {
      const res = await fetch(`${BASE_URL}/start-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15550192834", agentId: "admin" })
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || json.success === false) {
        // This is the honest outcome when Vobiz rejects the request — which it
        // does whenever answer_url is not a public HTTPS URL, i.e. whenever no
        // tunnel is running. Previously this path printed a tick.
        fail("outbound call", `HTTP ${res.status}: ${typeof json.error === "string" ? json.error : JSON.stringify(json.error) || "rejected"}`);
      } else if (!json.callUuid) {
        fail("outbound call", "no call identifier returned");
      } else if (/^uuid-\d+$/.test(json.callUuid)) {
        fail("outbound call", `fabricated identifier ${json.callUuid}`);
      } else {
        pass("outbound call", `call ${json.callUuid}`);
        const contact = json.pipedriveContact || {};
        if (contact.mocked) {
          skip("Pipedrive person lookup", "mock mode — no CRM was contacted");
        } else if (contact.pipedriveConfigured === false) {
          skip("Pipedrive person lookup", "Pipedrive not connected — run /auth/pipedrive");
        } else if (contact.person_id) {
          pass("Pipedrive person lookup", `person ${contact.person_id}`);
        } else {
          // The CRM answered; this number simply matches nobody, which is the
          // correct result for a reserved 555 test number.
          pass("Pipedrive person lookup", "CRM queried, no match for the test number");
        }
      }
    } catch (err) {
      fail("outbound call", err.message);
    }
  }

  // 3. Inbound Call & Recording Webhook Simulation
  if (runAll || args.includes("--mock-inbound")) {
    console.log(`\n[inbound] POST /recording-callback`);
    try {
      const callUuid = `test-call-uuid-${Date.now()}`;
      const res = await fetch(`${BASE_URL}/recording-callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          CallUUID: callUuid,
          RecordUrl: "https://media.vobiz.ai/v1/recording/sample-audio.mp3",
          RecordingID: "test-recording-id",
          RecordDuration: 42,
          From: "+15550192834",
          To: "+15550100000"
        })
      });
      const json = await res.json().catch(() => ({}));
      // The activity result is nested under `pipedriveActivity`; reading a
      // top-level `success` reported a failure while activities were in fact
      // being created.
      const activity = json.pipedriveActivity || {};
      if (!res.ok) {
        fail("recording callback", `HTTP ${res.status}`);
      } else if (activity.mocked) {
        skip("Pipedrive activity sync", "mock mode — nothing was written to any CRM");
      } else if (activity.pipedriveConfigured === false) {
        skip("Pipedrive activity sync", "Pipedrive not connected — run /auth/pipedrive");
      } else if (activity.success && activity.data && activity.data.id) {
        pass("Pipedrive activity sync", `activity #${activity.data.id}`);
      } else {
        fail("Pipedrive activity sync", activity.error || "no activity created");
      }
    } catch (err) {
      fail("recording callback", err.message);
    }
  }

  if (runAll || args.includes("--recording-proxy")) {
    console.log(`\n[recording] GET /recording-file`);

    // The security property is the assertion. This endpoint used to fetch any
    // URL a caller named, with the account's Vobiz credentials attached.
    try {
      const res = await fetch(`${BASE_URL}/recording-file?url=${encodeURIComponent("https://example.com/")}`);
      const body = await res.text();
      if (res.ok && /example domain/i.test(body)) {
        fail("recording proxy refuses arbitrary URLs", "SSRF: server fetched an attacker-named host");
      } else {
        pass("recording proxy refuses arbitrary URLs", `HTTP ${res.status}`);
      }
    } catch (err) {
      fail("recording proxy refuses arbitrary URLs", err.message);
    }

    for (const [name, qs] of [
      ["unsigned link rejected", "recordingId=abc"],
      ["forged signature rejected", "recordingId=abc&exp=99999999999&sig=forged"],
      ["expired signature rejected", "recordingId=abc&exp=1&sig=deadbeef"],
    ]) {
      try {
        const res = await fetch(`${BASE_URL}/recording-file?${qs}`);
        if (res.status === 403) pass(name);
        else fail(name, `expected 403, got ${res.status}`);
      } catch (err) {
        fail(name, err.message);
      }
    }
  }

  if (runAll || args.includes("--sync-cdrs")) {
    console.log(`\n[sync] GET /sync-recent-cdrs`);
    try {
      const res = await fetch(`${BASE_URL}/sync-recent-cdrs`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail("CDR sync", `HTTP ${res.status}`);
      } else if (json.mocked || json.mockMode) {
        skip("CDR sync", "mock mode — nothing was written to any CRM");
      } else if (json.pipedriveConfigured === false || /not configured|Not connected/i.test(JSON.stringify(json))) {
        skip("CDR sync", "Pipedrive not connected — run /auth/pipedrive");
      } else if (typeof json.synced === "number") {
        pass("CDR sync", `${json.synced} record(s)`);
      } else {
        fail("CDR sync", "no synced count returned");
      }
    } catch (err) {
      fail("CDR sync", err.message);
    }
  }

  summarise();
}

runTests().catch((err) => console.error("Test execution failed:", err));
