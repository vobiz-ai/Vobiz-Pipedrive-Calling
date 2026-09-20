<div align="center">

# Vobiz Calling for Pipedrive

**A browser softphone that logs every call to Pipedrive. Agents dial from the page, talk in the tab, and the call lands in the CRM as an Activity and a Call Log with duration and a signed recording link.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933.svg)](https://nodejs.org)

[Docs](https://www.vobiz.ai/docs/integrations/pipedrive) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What it does

| | |
| --- | --- |
| **Click-to-call** | Dial from the panel, or from a person record. |
| **Activity + Call Log** | Every call written through `POST /activities` and `POST /callLogs`. |
| **Caller lookup** | Inbound numbers resolved through `/persons/find`, falling back to `/itemSearch`. |
| **In-call controls** | Mute, Hold and Transfer while connected. |
| **Recordings** | Playable from the panel behind an HMAC-signed, short-expiry link. |
| **Browser audio** | Calls run over WebRTC in the tab. No desk phone, no desktop app. |

## The one thing to understand first

**The browser is the A leg.** The page sends the SIP INVITE itself; the backend
answers with `<Dial><Number>` to reach the customer.

```
browser ──SIP INVITE──▶ Vobiz ──answer_url──▶ backend /answer
                                                  │
                                           <Dial><Number> ──▶ customer
```

The intuitive design — the backend dials the customer over the REST API, then
bridges the agent in with `<Dial><User>` — **cannot work**. Routing *into* a
registered WebRTC endpoint is blocked platform-side: Vobiz builds a gateway URI
it cannot parse and drops its own INVITE. The customer answers, hears ringback,
then "the agent could not be reached".

Inbound is the exception: `<Dial><User>` is the only way to reach a registered
endpoint, and it works.

## Layout

```
backend/
  server.js             HTTP server: webhooks, softphone API, CRM sync
  pipedrive-oauth.js    OAuth 2.0 — authorize, exchange, refresh, api_domain
  test-pipedrive-sync.js  the suite. Exits non-zero on failure
  fetch-cdr.js          CLI: pull CDRs from Vobiz and sync them
  tunnel.js             cloudflared quick-tunnel helper
agent-phone/
  index.html            the softphone
  vobiz-sip.js          SIP layer: register, dial, answer, mute/hold/DTMF
pipedrive-app/          embedded CTI panel for Pipedrive
```

## Setup

You need: Node 18+, a [Vobiz](https://console.vobiz.ai) account with a number
and balance, a Pipedrive sandbox from
[developers.pipedrive.com](https://developers.pipedrive.com), and `cloudflared`
(or ngrok) for a public HTTPS URL.

### 1. Prove the Vobiz account first

Place a call with [rtc-demo.vobiz.ai](https://rtc-demo.vobiz.ai/). If that
fails, nothing here will work and you will debug the wrong layer for a day.

### 2. Create the SIP endpoint

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"pdagent","password":"<choose one>","alias":"Pipedrive Agent"}'
```

> **Vobiz rewrites the username you submit.** Send `pdagent` and the stored
> username comes back with a numeric suffix. Read the stored `username` out of
> the response — that is what registers, and what `VOBIZ_SIP_USER` must
> contain. Registering the name you chose fails in a way that looks like bad
> credentials.

### 3. Configure and start

```bash
cp backend/.env.example backend/.env    # fill it in
npm start                               # :8092 by default
cloudflared tunnel --url http://localhost:8092
```

Put the tunnel URL in `TUNNEL_URL`. Vobiz must reach `/answer`, `/dial-status`
and `/recording-callback` over public HTTPS.

**Check the answer URL is alive before touching any UI.** A dead one produces
the exact symptom people blame on registration:

```bash
curl -s -X POST "$TUNNEL_URL/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

You must get `<Response>` containing `<Dial …><Number>`. Anything else — an
ngrok interstitial, a 404 page — and every call dies.

### 4. Point Vobiz at the backend

Create an application whose `answer_url` is `$TUNNEL_URL/answer`, bind the SIP
endpoint to it, and attach a DID for inbound:

```bash
# create the application
curl -X POST ".../Account/$AUTH_ID/Application/" -d '{
  "app_name":"Pipedrive Calling","answer_url":"'"$TUNNEL_URL"'/answer",
  "answer_method":"POST","hangup_url":"'"$TUNNEL_URL"'/answer","hangup_method":"POST"}'

# bind the endpoint — the field is app_id, NOT the documented `application`,
# which is silently ignored and still returns 202 "changed"
curl -X POST ".../Account/$AUTH_ID/Endpoint/$ENDPOINT_ID/" -d '{"app_id":"'"$APP_ID"'"}'

# attach a DID for inbound. Lowercase /numbers, + encoded as %2B.
# /Number/ returns a bare 401 that reads like a credentials problem and is not.
curl -X POST ".../Account/$AUTH_ID/numbers/%2B91XXXXXXXXXX/application" \
  -d '{"application_id":"'"$APP_ID"'"}'      # 204 on success
```

### 5. Connect Pipedrive over OAuth

In **Developer Hub → Create public app**:

- **Callback URL**: `$TUNNEL_URL/auth/pipedrive/callback` — must match
  `PIPEDRIVE_REDIRECT_URI` exactly. Only one callback URL is allowed per app.
- **Scopes**, and nothing more. Over-scoping is a documented rejection reason:

  | Toggle | Setting | Used for |
  |---|---|---|
  | Deals | Read only | activities link to `deal_id` |
  | Activities | Full access | `POST /activities` |
  | Contacts | Read only | `/persons/find` caller lookup |
  | Search for all data | on | `/itemSearch` fallback lookup |
  | Call logs | on | `POST /callLogs` |

Put the Client ID and Secret in `.env`, then visit `$TUNNEL_URL/auth/pipedrive`
and approve. `GET /auth/pipedrive/status` should then report
`"connected": true`.

## Using it

Open **`http://localhost:8092/agent-phone/index.html`**, sign in with the Vobiz
Auth ID and Auth Token, and allow the microphone.

Wait for the status to read **Ready** — that is JsSIP registering. The Call
button is disabled until then, deliberately: dialling with SIP down rings the
customer into silence.

- **Outbound** — type a number, hit Call.
- **Inbound** — call the DID you attached in step 4.

## Testing

```bash
npm test          # everything
npm run test:outbound
npm run test:inbound
npm run test:recording      # SSRF regression tests
npm run test:sync
```

The suite reports **PASS / FAIL / SKIP** and **exits non-zero on failure**. SKIP
means a service is not configured — it is not a pass, and the summary says so.

A fully configured run is `9 passed, 0 failed, 0 skipped`.

## When something breaks

The backend log is the honest account. The field that matters:

```
[DIAL RESULT] status=completed ring=true cause=NORMAL_CLEARING bleg=abc-123 dur=42
```

**`DialBLegUUID` is the single most useful field in this stack.** Present means
it connected; empty means no B leg was ever created, whatever the UI showed.

| Symptom | Cause |
|---|---|
| No `WEBHOOK /answer` line at all | Endpoint not bound to the application, or `TUNNEL_URL` is stale |
| `bleg=(none…)` | Destination unreachable, or the caller ID is not owned by this account |
| No CDR in Vobiz at all | `422 Session Interval Too Small` — a session-timer problem |
| CDR billed `0s` | SDP/ICE — check STUN candidates in the browser console |
| Panel stuck on "Connecting…" | Backend unreachable, or it crashed — check the log |
| "Registration failed" | Wrong `VOBIZ_SIP_USER` — you probably used the name you submitted, not the one Vobiz stored |
| Caller hears ringback then the fallback | `<Dial><User>` naming an endpoint that is not registered |

Three client settings are **not optional**, and all three fail in ways that
point nowhere near the cause. They are in `agent-phone/vobiz-sip.js`:

| Setting | Symptom without it |
|---|---|
| `session_timers: false` | `422`, surfaced as the opaque cause "SIP Failure Code", and **no CDR at all** |
| `pcConfig.iceServers` | host-only candidates, "Incompatible SDP", CDR billed `0s` |
| space-free `user_agent` | Vobiz interpolates it unescaped into a gateway URI; JsSIP's default contains a space |

Ignore the Endpoint API's `sip_registered`. It reads `"false"` even when
registration genuinely succeeded, on every endpoint on the account. The panel
gates on JsSIP's `registered` event instead.

**Quick tunnels are the most common cause of "it stopped working."** The
hostname changes on every restart, and three things go stale together:
`TUNNEL_URL`, the Vobiz application's `answer_url`, and the Pipedrive OAuth
callback. Use a stable hostname for anything beyond a demo.

## Known limitations

- **Single-tenant token storage.** Works for one organization; real
  multi-tenant operation needs a database with encryption at rest.
- **One SIP endpoint per install.** Two agents on one install register as the
  same endpoint and race for calls.
- **No transfers between agents.** In-call Transfer routes to a number.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/pipedrive**

## License

[MIT](LICENSE)
