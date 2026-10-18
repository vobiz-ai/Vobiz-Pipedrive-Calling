const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8092;
const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");

console.log(`\n==================================================`);
console.log(`🌐 Launching Cloudflare Quick Tunnel for Port ${PORT}`);
console.log(`==================================================`);

// Path to local cloudflared binary if present, or rely on system PATH
const localCloudflared = path.join(__dirname, "cloudflared.exe");
const cloudflaredCmd = fs.existsSync(localCloudflared) ? localCloudflared : "cloudflared";

const tunnelArgs = ["tunnel", "--protocol", "http2", "--url", `http://localhost:${PORT}`];

console.log(`Running: ${cloudflaredCmd} ${tunnelArgs.join(" ")}`);

const child = spawn(cloudflaredCmd, tunnelArgs, { shell: true });

let tunnelUrlFound = false;

child.stdout.on("data", (data) => {
  handleOutput(data.toString());
});

child.stderr.on("data", (data) => {
  handleOutput(data.toString());
});

function handleOutput(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.includes(".trycloudflare.com")) {
      const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !tunnelUrlFound) {
        tunnelUrlFound = true;
        const publicUrl = match[0];
        fs.writeFileSync(TUNNEL_URL_FILE, publicUrl, "utf8");
        console.log(`\n==================================================`);
        console.log(`🎉 PUBLIC TUNNEL ESTABLISHED!`);
        console.log(`==================================================`);
        console.log(`🔗 Public Base URL: ${publicUrl}`);
        console.log(`📞 Vobiz Answer Callback:            ${publicUrl}/answer`);
        console.log(`🎙️  Vobiz Recording Callback:         ${publicUrl}/recording-callback`);
        console.log(`🔚 Vobiz Hangup Callback:            ${publicUrl}/hangup-callback`);
        console.log(`🔐 Pipedrive OAuth callback:         ${publicUrl}/auth/pipedrive/callback`);
        console.log(`\nThe hostname changes on every restart: update the Vobiz application's`);
        console.log(`answer_url / hangup_url and the Pipedrive app's callback URL to match.`);
        console.log(`==================================================\n`);
      }
    }
  }
}

child.on("error", (err) => {
  console.error("❌ Cloudflare Tunnel failed to start:", err.message);
  console.error("Ensure cloudflared is installed or available in PATH.");
});

child.on("close", (code) => {
  console.log(`Cloudflare tunnel process exited with code ${code}`);
});
