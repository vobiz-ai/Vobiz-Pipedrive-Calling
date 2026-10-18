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
| **Click-to-call** | Dial from the softphone panel. |
| **Activity + Call Log** | Every recorded call written through `POST /activities` and `POST /callLogs`, with the audio attached. |
| **Caller lookup** | Inbound numbers resolved through `/persons/find`, falling back to `/itemSearch`. |
| **In-call controls** | Mute, Hold and DTMF keypad while connected. |
| **Recordings** | Attached to the Pipedrive Call Log, and playable from the panel behind an HMAC-signed, short-expiry link. |
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
  static-files.js       serves agent-phone/ and pipedrive-app/ only
  vobiz-signature.js    Vobiz callback signature check (V3/V2)
  test/                 offline test suite (npm test)
agent-phone/
  index.html            the softphone
  vobiz-sip.js          SIP layer: register, dial, answer, mute/hold/DTMF
pipedrive-app/          entry point for a Pipedrive app extension; opens the softphone
```

## Setup

You need: Node 18+, a [Vobiz](https://console.vobiz.ai) account with a number
and balance, a Pipedrive sandbox from
[developers.pipedrive.com](https://developers.pipedrive.com), and `cloudflared`
(or ngrok) for a public HTTPS URL.

### 1. Prove the Vobiz account first

Place a call with [rtc-demo.vobiz.ai](https://rtc-demo.vobiz.ai/). If that
fails, nothing here will work and you will debug the wrong layer for a day.

### 2. Start the backend and a tunnel

```bash
cp backend/.env.example backend/.env    # fill in VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_FROM_NUMBER
npm start                               # :8092 by default
cloudflared tunnel --url http://localhost:8092    # in a second terminal
```

Put the tunnel URL in `TUNNEL_URL` in `backend/.env` and restart `npm start`.
Vobiz must reach `/answer`, `/dial-status` and `/recording-callback` over
public HTTPS.

**Check the answer URL is alive before touching any UI.** A dead one produces
the exact symptom people blame on registration:

```bash
curl -s -X POST "$TUNNEL_URL/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

You must get `<Response>` containing `<Dial …><Number>`. Anything else — an
ngrok interstitial, a 404 page — and every call dies.

### 3. Create the Vobiz application, endpoint and number routing

```bash
export AUTH_ID=MA_XXXXXXXX AUTH_TOKEN=... TUNNEL_URL=https://....trycloudflare.com
H=(-H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json")
API=https://api.vobiz.ai/api/v1/Account/$AUTH_ID

# 1. the application: answer_url and hangup_url both point at /answer
curl -s -X POST "$API/Application/" "${H[@]}" -d '{
  "app_name":"Pipedrive Calling",
  "answer_url":"'"$TUNNEL_URL"'/answer","answer_method":"POST",
  "hangup_url":"'"$TUNNEL_URL"'/answer","hangup_method":"POST"}'
# -> note "app_id"

# 2. the SIP endpoint the softphone registers as, bound to that application
curl -s -X POST "$API/Endpoint/" "${H[@]}" -d '{
  "username":"pdagent01","password":"<choose a strong one>",
  "alias":"Pipedrive_Agent","application":<APP_ID>}'
# -> note "endpoint_id" and "sip_uri"

# 3. confirm the binding: application.app_id must be your APP_ID
curl -s "$API/Endpoint/<ENDPOINT_ID>/" "${H[@]}"

# 4. route a DID to the application for inbound (lowercase /numbers, + as %2B)
curl -s -X POST "$API/numbers/%2B91XXXXXXXXXX/application" "${H[@]}" \
  -d '{"application_id":"<APP_ID>"}'
```

Put the user part of the returned `sip_uri` in `VOBIZ_SIP_USER` and the
password in `VOBIZ_SIP_PASSWORD`. Use the `sip_uri` Vobiz returns, not the
name you typed. Usernames are alphanumeric only.

### 4. Connect Pipedrive over OAuth

In **Developer Hub → Create app** (a private app is enough for one company):

- **Callback URL**: `$TUNNEL_URL/auth/pipedrive/callback` — must match
  `PIPEDRIVE_REDIRECT_URI` exactly. Only one callback URL is allowed per app.
- **Scopes**, and nothing more. Over-scoping is a documented rejection reason:

  | Toggle | Setting | Used for |
  |---|---|---|
  | Deals | Read only | activities link to `deal_id` |
  | Activities | Full access | `POST /activities` |
  | Contacts | Read only | `/persons/find` caller lookup |
  | Search for all data | on | `/itemSearch` fallback lookup |
  | Call logs | on | `POST /callLogs` and the recording upload |

Put the Client ID and Secret in `.env`, restart, then visit
`$TUNNEL_URL/auth/pipedrive` and approve. `GET /auth/pipedrive/status` should
then report `"connected": true`. To connect a different company later, sign in
to the softphone and `POST /auth/pipedrive/disconnect` first.

### 5. Turn on strict webhook signatures

Make one call, then look for `[signature] valid Vobiz signature on /answer` in
the backend log. Once you see it, set `VOBIZ_WEBHOOK_SIGNATURES=require` so
unsigned requests to the webhook routes are rejected. The default (`verify`)
rejects a wrong signature but lets an unsigned callback through, because Vobiz
does not sign every callback type on every account.

## Using it

Open **`http://localhost:8092/`**, sign in with the Vobiz Auth ID and Auth
Token **of the account this server is configured for**, and allow the
microphone. Any other credentials are refused.

Wait for the status to read **Ready**. That is JsSIP registering. The Call
button is disabled until then, deliberately: dialling with SIP down rings the
customer into silence.

- **Outbound** — pick the caller ID, type a number, hit Call.
- **Inbound** — call the DID you routed in step 3. **Enter** accepts,
  **Escape** declines.
- After a call, the recording callback writes a Pipedrive **Activity** and a
  **Call Log** with the recording attached.

The *SIP direct* tab registers with an endpoint's own SIP credentials and can
call, but has no backend session, so CRM lookups and the recordings list need
an account sign-in.

## Testing

```bash
npm test                   # offline: boots the server against fakes, no credentials, no network
npm run test:live          # against a running `npm start` and your real services
npm run test:answer        # just: does the public answer URL return <Dial><Number>?
npm run test:inbound       # writes ONE test Activity + Call Log to the connected Pipedrive
npm run test:recording     # recording-proxy regression checks
npm run test:sync          # CDR backfill
```

`npm test` covers path traversal, sign-in, session gating, CORS, the answer
XML in both directions, webhook signatures and the exact Pipedrive payloads.
The live checks report **PASS / FAIL / SKIP** and exit non-zero on failure.
SKIP means a service is not configured. It is not a pass.

## When something breaks

The backend log is the honest account. The field that matters:

```
[DIAL RESULT] status=completed ring=true cause=NORMAL_CLEARING bleg=abc-123 dur=42
```

**`DialBLegUUID` is the single most useful field in this stack.** Present means
it connected; empty means no B leg was ever created, whatever the UI showed.

| Symptom | Cause |
|---|---|
| No `[/answer]` line at all | Endpoint not bound to the application, or `TUNNEL_URL` is stale |
| `bleg=(none…)` | Destination unreachable, or the caller ID is not owned by this account |
| No CDR in Vobiz at all | `422 Session Interval Too Small` — a session-timer problem |
| CDR billed `0s` | SDP/ICE — check STUN candidates in the browser console |
| Panel stuck on "Connecting…" | Backend unreachable, or it crashed — check the log |
| "Registration failed" | Wrong `VOBIZ_SIP_USER` / `VOBIZ_SIP_PASSWORD` — use the user part of the `sip_uri` Vobiz returned |
| `[signature] INVALID` in the log | `TUNNEL_URL` does not match the URL Vobiz is calling — update it and the application's `answer_url` |
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

- **Single account, single endpoint.** One install signs in with one Vobiz
  account and registers one SIP endpoint. Two agents on one install register as
  the same endpoint and race for calls.
- **Single-tenant token storage.** OAuth tokens live in
  `backend/.pipedrive-tokens.json` (mode 0600, gitignored). Multi-tenant
  operation needs a database with encryption at rest.
- **Calls are logged when the recording is ready.** The Activity and Call Log
  are written from the recording callback, so an unanswered call (no
  recording) is not logged. `npm run fetch-cdr` backfills from CDRs, and does
  not de-duplicate against calls already logged.
- **No call transfer.**
- **Not yet a Pipedrive Marketplace app.** OAuth is in place; the listing
  itself (app extension manifest, privacy policy, review) is not.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/pipedrive**

## License

[MIT](LICENSE)
