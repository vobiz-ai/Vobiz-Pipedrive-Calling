const crypto = require("crypto");

/**
 * Vobiz callback signatures (https://www.vobiz.ai/docs/concepts/validating-callbacks).
 *
 *   V3 = base64(HMAC-SHA256(key = Auth Token, msg = baseURL + "." + nonce))
 *   V2 = base64(HMAC-SHA256(key = Auth Token, msg = baseURL + nonce))
 *
 * baseURL is the callback URL with the query string removed. The signature
 * covers the URL and the nonce, never the body — voice webhooks are
 * form-encoded, so a body-hashing scheme never verifies. Behind a tunnel the
 * URL Vobiz called is the public one, so it is rebuilt from TUNNEL_URL.
 */
function baseUrlFor(publicBaseUrl, pathname) {
  return `${String(publicBaseUrl || "").replace(/\/+$/, "")}${pathname}`;
}

function sign(authToken, msg) {
  return crypto.createHmac("sha256", authToken).update(msg).digest("base64");
}

function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Returns "valid", "invalid" or "absent".
 */
function checkSignature(headers, authTokens, url) {
  const h = (name) => headers[name.toLowerCase()];
  const v3 = h("X-Vobiz-Signature-V3");
  const v3n = h("X-Vobiz-Signature-V3-Nonce");
  const v2 = h("X-Vobiz-Signature-V2");
  const v2n = h("X-Vobiz-Signature-V2-Nonce");
  if (!v3 && !v2) return "absent";
  const tokens = (Array.isArray(authTokens) ? authTokens : [authTokens]).filter(Boolean);
  for (const authToken of tokens) {
    if (v3 && v3n && equal(v3, sign(authToken, `${url}.${v3n}`))) return "valid";
    if (v2 && v2n && equal(v2, sign(authToken, `${url}${v2n}`))) return "valid";
  }
  return "invalid";
}

/**
 * VOBIZ_WEBHOOK_SIGNATURES:
 *   require — reject any callback without a valid signature (recommended once
 *             you have seen "[signature] valid" in the log for your setup)
 *   verify  — default. Reject a callback whose signature is present but
 *             wrong; let an unsigned one through with a warning, because
 *             Vobiz does not sign every callback type on every account.
 *   off     — do not check.
 */
/**
 * The key is the Auth Token of the account the callback belongs to. This
 * backend serves many accounts, so the caller passes the candidate token(s)
 * per request: the one account the call was routed to when it is known, or
 * every signed-in account's token when it is not (a signature valid for any
 * of them is accepted; one valid for none is rejected; unsigned follows the
 * mode below).
 */
function makeVerifier({ mode, publicBaseUrl }) {
  const m = String(mode || "verify").toLowerCase();
  let warnedAbsent = false;
  let loggedValid = false;
  // opts.noKey: the callback belongs to a SIP-direct agent, for whom this
  // server holds no Auth Token. A signature it cannot check is then treated
  // like an unsigned callback (allowed in "verify", refused in "require").
  return function verify(req, pathname, authTokens, opts = {}) {
    if (m === "off") return true;
    const url = baseUrlFor(publicBaseUrl(), pathname);
    let result = checkSignature(req.headers || {}, authTokens, url);
    if (result === "invalid" && opts.noKey) {
      console.warn(`[signature] cannot check the signature on ${pathname}: SIP-direct call, no Auth Token held for its account`);
      result = "absent";
    }
    if (result === "valid") {
      if (!loggedValid) { console.log(`[signature] valid Vobiz signature on ${pathname}`); loggedValid = true; }
      return true;
    }
    if (result === "invalid") {
      console.error(`[signature] INVALID Vobiz signature on ${pathname} (checked against ${url}) — rejected. If TUNNEL_URL is stale, fix it.`);
      return false;
    }
    if (m === "require") {
      console.error(`[signature] unsigned callback on ${pathname} rejected (VOBIZ_WEBHOOK_SIGNATURES=require)`);
      return false;
    }
    if (!warnedAbsent) {
      console.warn(`[signature] unsigned callback on ${pathname} accepted. Set VOBIZ_WEBHOOK_SIGNATURES=require once your callbacks arrive signed.`);
      warnedAbsent = true;
    }
    return true;
  };
}

module.exports = { checkSignature, makeVerifier, baseUrlFor, sign };
