# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

Be clear-eyed about this before deploying. The list below is honest rather than
reassuring.

### What is handled

**The browser never holds your Vobiz Auth Token.** It is posted once at sign-in
and exchanged for an opaque session token. On the server it lives in memory
only, keyed by Auth ID — never written to disk, never logged, never returned in
a response.

**No account credentials in configuration.** `.env` holds no Vobiz Auth ID,
Auth Token, SIP credentials or numbers. The endpoint store
(`backend/data/endpoints.json`, mode 0600) holds endpoint ids and SIP
usernames, never passwords or tokens. Each sign-in sets a fresh random SIP
password and gives it only to that browser session.

**Recording links carry no credentials.** They are HMAC-signed with a short
expiry over the Auth ID and the recording id, and the audio is fetched
server-side with that account's credentials. A link that leaks grants nothing
but that one recording, only until it expires, and can never be re-pointed at
another account's audio.

**Recording playback takes no caller-supplied URL.** An earlier generation of
this pattern accepted a `url` parameter and fetched it with the account's Vobiz
credentials attached — a credential-exfiltration primitive any web page could
drive. Never reintroduce one.

**CORS is an allowlist**, not `*`.

**Sign-in is verified by Vobiz.** Any Vobiz account may sign in, but only with
a pair Vobiz itself accepts (anything but a 2xx from `GET /numbers` is
refused). Every route that reads recordings, reads CRM data or writes to the
CRM requires the resulting session, and acts only on that session's account.
Caller IDs are limited to the account's own active numbers. Provisioning only
creates or updates this integration's own application and endpoints; attaching
a number for inbound happens only on the explicit "Enable inbound calls"
action.

**Only the softphone is served.** Static files come from `agent-phone/` and
`pipedrive-app/` only; `backend/.env`, the token store and the source tree are
not reachable over HTTP.

**Webhooks can be verified.** Vobiz callback signatures (V3/V2) are checked
against the Auth Token of the account the callback belongs to; set
`VOBIZ_WEBHOOK_SIGNATURES=require` to reject unsigned callbacks.

**The SIP password is not stored in the browser.** In SIP-direct mode only the
username and caller ID are remembered, and the password is never sent to the
backend.

### What is not handled

**SIP direct is unauthenticated routing state.** The backend cannot prove a
SIP-direct browser holds the endpoint's password, so `POST /api/sip-direct`
only records "this SIP user calls out as / receives calls on this number". It
cannot claim an endpoint an account sign-in provisioned, and Vobiz refuses a
caller ID the account does not own, but anyone who can reach the backend can
set such a mapping for an unprovisioned SIP username. SIP-direct webhooks
cannot be signature-checked (no token is held), so `require` mode refuses them.

**Any Vobiz account can use this backend.** Calls are billed to the account
that signs in, but every account's calls are logged into the one connected
Pipedrive company. Restrict who can reach the backend if that matters.

**There is no per-agent identity.** The agent id selects a label, not an
identity, and nothing stops a signed-in user from asserting another.

**Deployment secrets live in `.env`** (signing secret, Pipedrive client). There
is no secret manager and no encryption at rest. Treat the host as sensitive.

**A quick tunnel is not production infrastructure.** Its hostname changes on
every restart and it is publicly reachable while it is up.

Deploying this as-is for real customer traffic needs, at minimum: an identity
store for agents, a stable hostname, and secrets held somewhere better than a
file.
