const crypto = require("crypto");

/**
 * The admin of this backend: whoever holds ADMIN_TOKEN. Only the admin can
 * connect a Pipedrive company, link it to a Vobiz account, or list and
 * disconnect companies.
 *
 * Accepted as `Authorization: Bearer <ADMIN_TOKEN>`, or as the `vz_pd_admin`
 * cookie that POST /admin/session sets once the token has been typed in (the
 * OAuth connect is a browser navigation, which cannot send a header).
 *
 * The cookie is scoped to the path of PUBLIC_BASE_URL (`/pipedrive` on a
 * shared host), never `/`: several backends share one host there, and a
 * root-scoped cookie would be sent to, and overwritten by, all of them.
 */
const ADMIN_COOKIE = "vz_pd_admin";
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

/** "/pipedrive" for https://integrations.example.com/pipedrive, "/" at the root. */
function cookiePathFor(publicBaseUrl) {
  try {
    return new URL(publicBaseUrl).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

function createAdminAuth({ adminToken, secret, publicBaseUrl }) {
  const mac = (value) => crypto.createHmac("sha256", secret).update(`admin-session\n${value}`).digest("base64url");
  const cookiePath = () => cookiePathFor(publicBaseUrl());
  const isHttps = (req) =>
    Boolean(req.socket && req.socket.encrypted) ||
    String((req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim() === "https" ||
    /^https:/i.test(publicBaseUrl() || "");

  return {
    configured: () => Boolean(adminToken),
    verifyToken: (token) => Boolean(adminToken) && safeEqual(token, adminToken),
    cookie(req) {
      const exp = Date.now() + ADMIN_SESSION_MS;
      const value = `${exp}.${mac(exp)}`;
      return `${ADMIN_COOKIE}=${value}; Path=${cookiePath()}; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_MS / 1000}` +
        (isHttps(req) ? "; Secure" : "");
    },
    clearCookie: () => `${ADMIN_COOKIE}=; Path=${cookiePath()}; HttpOnly; SameSite=Strict; Max-Age=0`,
    isAdmin(req) {
      if (!adminToken) return false;
      const header = String((req.headers && req.headers.authorization) || "");
      if (header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), adminToken)) return true;
      const [exp, sig] = String(parseCookies(req.headers && req.headers.cookie)[ADMIN_COOKIE] || "").split(".");
      return Number(exp) > Date.now() && safeEqual(sig, mac(exp));
    },
  };
}

module.exports = { createAdminAuth, cookiePathFor, parseCookies, safeEqual, ADMIN_COOKIE };
