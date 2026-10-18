const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, rawGet, SECRET_MARKER } = require("./harness");

// Regression: GET /../backend/.env and GET /backend/.env both returned the whole
// env file — Auth Token, SIP password, signing secret, Pipedrive client secret.
test("static file server never leaves agent-phone/ or pipedrive-app/", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  const refused = [
    "/backend/.env",
    "/../backend/.env",
    "/agent-phone/../backend/.env",
    "/pipedrive-app/../backend/.env",
    "/%2e%2e/backend/.env",
    "/agent-phone/%2e%2e/backend/.env",
    "/..%2fbackend%2f.env",
    "/backend/server.js",
    "/backend/.pipedrive-tokens.json",
    "/backend/agents.json",
    "/backend/data/endpoints.json",
    "/data/endpoints.json",
    "/package.json",
    "/.git/config",
    "/.gitignore",
    "/agent-phone/../../../../etc/passwd",
  ];
  for (const p of refused) {
    const r = await rawGet(srv.base, p);
    assert.equal(r.status, 404, `${p} should be 404, got ${r.status}`);
    assert.ok(!r.body.includes(SECRET_MARKER), `${p} leaked a secret`);
  }
});

test("the softphone and the Pipedrive panel are still served", async (t) => {
  const srv = await startServer();
  t.after(srv.stop);

  for (const [p, type] of [
    ["/", "text/html"],
    ["/agent-phone/index.html", "text/html"],
    ["/softphone.js", "text/javascript"],
    ["/vobiz-sip.js", "text/javascript"],
    ["/lib/jssip.min.js", "text/javascript"],
    ["/style.css", "text/css"],
    ["/agent-phone/lib/jssip.min.js", "text/javascript"],
    ["/pipedrive-app/pipedrive-cti-app.html", "text/html"],
  ]) {
    const r = await rawGet(srv.base, p);
    assert.equal(r.status, 200, `${p} should be served`);
    assert.ok(String(r.headers["content-type"]).startsWith(type), `${p} content-type ${r.headers["content-type"]}`);
  }
});
