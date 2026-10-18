const fs = require("fs");
const path = require("path");

/**
 * Static files the backend is allowed to serve: the softphone and the
 * Pipedrive panel. Nothing else.
 *
 * This used to join the request path onto the repository root, so
 * `GET /backend/.env` returned the account Auth Token, the SIP password, the
 * signing secret and the Pipedrive client secret, and `/../backend/.env` did the
 * same through the agent-phone fallback. Every request is now resolved inside
 * one of these directories and refused if it would leave it.
 */
const REPO_ROOT = path.resolve(__dirname, "..");
const AGENT_PHONE_DIR = path.join(REPO_ROOT, "agent-phone");
const PIPEDRIVE_APP_DIR = path.join(REPO_ROOT, "pipedrive-app");

const PREFIXES = [
  ["/agent-phone/", AGENT_PHONE_DIR],
  ["/pipedrive-app/", PIPEDRIVE_APP_DIR],
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Map a URL pathname to a file on disk, or null if it must not be served.
 * The softphone is also reachable at `/`, so `/softphone.js` resolves inside
 * agent-phone/ — and only there.
 */
function resolveStaticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || "/"));
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  let root = AGENT_PHONE_DIR;
  let rel = decoded;
  for (const [prefix, dir] of PREFIXES) {
    if (decoded.startsWith(prefix)) {
      root = dir;
      rel = decoded.slice(prefix.length);
      break;
    }
  }
  rel = rel.replace(/^\/+/, "");
  if (rel === "") rel = root === PIPEDRIVE_APP_DIR ? "pipedrive-cti-app.html" : "index.html";

  // No dotfiles and no `..` segments, before any resolution happens.
  if (rel.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return null;

  const full = path.resolve(root, rel);
  if (!within(root, full)) return null;
  if (!MIME_TYPES[path.extname(full).toLowerCase()]) return null;

  try {
    // Refuse symlinks that point outside the served directory.
    const real = fs.realpathSync(full);
    if (!within(fs.realpathSync(root), real)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function contentTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

module.exports = { resolveStaticFile, contentTypeFor, AGENT_PHONE_DIR, PIPEDRIVE_APP_DIR };
