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
  vobiz-accounts.js     multi-account sign-in, per-account app/endpoint provisioning, webhook routing
  pipedrive-oauth.js    OAuth 2.0 — authorize, exchange, refresh, api_domain
  test-pipedrive-sync.js  live checks against a running backend. Exits non-zero on failure
  fetch-cdr.js          CLI: pull CDRs from Vobiz and sync them (credentials as flags)
  data/                 endpoints.json: endpoint id + SIP username per account/agent (gitignored)
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
cp backend/.env.example backend/.env    # deployment config only — no Vobiz credentials
npm start                               # :8092 by default
cloudflared tunnel --url http://localhost:8092    # in a second terminal
```

Put the tunnel URL in `TUNNEL_URL` in `backend/.env` and restart `npm start`.
Vobiz must reach `/answer`, `/dial-status`, `/recording-callback` and
`/hangup-callback` over public HTTPS, and sign-in points each account's
application at `$TUNNEL_URL/answer`, so set it before anyone signs in.

`backend/.env` holds **no** Vobiz Auth ID, Auth Token, SIP credentials or
numbers. What stays there is deployment config: `PORT`, `TUNNEL_URL`,
`SIGNING_SECRET`, `DATA_DIR`, `VOBIZ_WEBHOOK_SIGNATURES`, `ALLOWED_ORIGINS` and
the Pipedrive OAuth client.

### 3. Sign in — the Vobiz side sets itself up

Open the softphone and sign in on the **Vobiz account** tab with your Auth ID
and Auth Token (console.vobiz.ai → API credentials). **Any Vobiz account
works**; several accounts can use one backend at once. On sign-in the backend:

1. checks the pair with Vobiz (`GET /numbers` — anything but a 2xx is refused);
2. finds this integration's application in your account — the one whose
   `answer_url` is `$TUNNEL_URL/answer`, or one named `Vobiz-Pipedrive-Calling`
   that it created earlier — or creates it. It never repoints any other
   application;
3. finds or creates **one SIP endpoint per agent profile** (alias
   `pipedrive-<agent>`), binds it to that application (`{"app_id":"<id>"}`,
   verified by reading the endpoint back, with the documented
   `{"application": <id>}` as the fallback), and sets a **fresh random SIP
   password**, handed only to that browser session;
4. loads your active, voice-enabled numbers into the caller-ID picker.

Only the endpoint id and SIP username are saved (`backend/data/endpoints.json`,
mode 0600, gitignored). The Auth Token stays in server memory, keyed by Auth
ID; it is never written to disk, logged, or sent back to the browser.

**Inbound calls** are opt-in, per number: pick the number and press **Enable
inbound calls on this number**. That attaches the DID to the integration's
application (`POST /numbers/%2B<digits>/application`), which **moves it off
whatever application it was on** — the panel tells you which one first.
Incoming calls ring every signed-in agent of the account that owns the number
(the webhook's `ParentAuthID`, or the dialled number when that is absent).

**Check the answer URL is alive before relying on calls.** A dead one produces
the exact symptom people blame on registration. An unknown SIP user gets a
polite `<Hangup/>`; that still proves the URL is reachable:

```bash
curl -s -X POST "$TUNNEL_URL/answer" -d "From=sip:check@registrar.vobiz.ai&To=10000000000&RouteType=sip"
```

You must get a `<Response>`. An ngrok interstitial or a 404 page means every
call will die.

#### SIP direct (no account credentials)

The **SIP direct** tab registers with an *existing* endpoint's SIP username and
password plus a caller ID you type (E.164, e.g. `+<country code><number>`). The
password stays in the browser; the backend only records "this SIP user calls out
as, and receives calls on, this number" so it can route that endpoint's
webhooks. Recordings, the number list, CRM lookups and *Enable inbound calls*
need a Vobiz account sign-in and are unavailable in this mode.

Because the backend holds no credentials for that account, **you** bind the
endpoint and the number to an application whose answer URL is this backend:

- **Console:** Voice → Applications → create one with Answer URL
  `$TUNNEL_URL/answer` (POST) and Hangup URL `$TUNNEL_URL/hangup-callback`
  (POST). Voice → Endpoints → your endpoint → set *Application* to it. Phone
  Numbers → your number → set *Application* to it.
- **API equivalent:**

  ```bash
  H=(-H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json")
  API=https://api.vobiz.ai/api/v1/Account/$AUTH_ID
  curl -s -X POST "$API/Application/" "${H[@]}" -d '{"app_name":"Vobiz-Pipedrive-Calling",
    "answer_url":"'"$TUNNEL_URL"'/answer","answer_method":"POST",
    "hangup_url":"'"$TUNNEL_URL"'/hangup-callback","hangup_method":"POST"}'      # -> app_id
  curl -s -X POST "$API/Endpoint/<ENDPOINT_ID>/" "${H[@]}" -d '{"app_id":"<APP_ID>"}'
  curl -s "$API/Endpoint/<ENDPOINT_ID>/" "${H[@]}"     # application.app_id must be <APP_ID>
  curl -s -X POST "$API/numbers/%2B<DIGITS>/application" "${H[@]}" -d '{"application_id":"<APP_ID>"}'
  ```

  Keep `app_id` as a string: it is 17 digits, beyond what a JavaScript number
  holds exactly.

A SIP-direct call's webhook signature cannot be checked (no Auth Token is held
for its account), so it is treated as unsigned: accepted under the default
`VOBIZ_WEBHOOK_SIGNATURES=verify`, refused under `require`.

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

Each callback is checked with the Auth Token of the account it belongs to
(found from the call, the SIP user, `ParentAuthID` or the dialled number). Make
one call, then look for `[signature] valid Vobiz signature on /answer` in
the backend log. Once you see it, set `VOBIZ_WEBHOOK_SIGNATURES=require` so
unsigned requests to the webhook routes are rejected. The default (`verify`)
rejects a wrong signature but lets an unsigned callback through, because Vobiz
does not sign every callback type on every account.

## Using it

Open **`http://localhost:8092/`**, sign in with **your** Vobiz Auth ID and Auth
Token (any account) or on the SIP direct tab, and allow the microphone.

Wait for the status to read **Ready**. That is JsSIP registering. The Call
button is disabled until then, deliberately: dialling with SIP down rings the
customer into silence.

- **Outbound** — pick the caller ID (only your account's active, voice-enabled
  numbers are offered, and the backend refuses any other), type a number, hit
  Call.
- **Inbound** — after *Enable inbound calls* on a number, call it. **Enter**
  accepts, **Escape** declines.
- After a call, the recording callback writes a Pipedrive **Activity** and a
  **Call Log** with the recording attached.

Signing in again rotates the endpoint's SIP password, so a second browser
signed in as the same agent profile loses its registration. Give each person
their own agent profile (`backend/agents.json`, see `agents.example.json`).

## Testing

```bash
npm test                   # offline: boots the server against fakes, no credentials, no network
# live checks take the account at runtime, never from .env:
AUTH_ID=... AUTH_TOKEN=... npm run test:live      # against a running `npm start` and your real services
npm run test:answer        # just: does the public answer URL return <Dial><Number>?
npm run test:inbound       # writes ONE test Activity + Call Log to the connected Pipedrive
npm run test:recording     # recording-proxy regression checks
npm run test:sync          # CDR backfill
```

`npm test` covers path traversal, sign-in for two different accounts at once,
provisioning (including the exact 17-digit bind body), per-account webhook
routing in both directions, SIP direct, per-account webhook signatures,
account-scoped recording links, that the Auth Token never appears in a
response, session gating, CORS and the exact Pipedrive payloads.
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
| No `[/answer]` line at all | Endpoint not bound to the application (look for `NOT bound` in the sign-in log), or `TUNNEL_URL` is stale — sign in again after fixing it |
| `outbound from unknown SIP user` | The backend restarted (sign-ins are in memory) — sign in again |
| `no signed-in agent for this account or number` | Nobody from the account that owns the dialled number is signed in |
| `bleg=(none…)` | Destination unreachable, or the caller ID is not owned by this account |
| No CDR in Vobiz at all | `422 Session Interval Too Small` — a session-timer problem |
| CDR billed `0s` | SDP/ICE — check STUN candidates in the browser console |
| Panel stuck on "Connecting…" | Backend unreachable, or it crashed — check the log |
| "Registration failed" | Account mode: the same agent profile signed in elsewhere and rotated the password — sign in again. SIP direct: wrong username/password — use the user part of the endpoint's `sip_uri` |
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
callback. Signing in again repoints the integration's own application; the
Pipedrive callback you update by hand. Use a stable hostname for anything
beyond a demo.

## Known limitations

- **Sign-ins live in memory.** After a backend restart every agent signs in
  again. Until someone from an account does, that account's calls are hung up
  politely and its signed recording links return "sign in again" (HTTP 409).
- **One endpoint per agent profile.** Two people using the same profile share
  one endpoint, and each sign-in rotates its password.
- **One Pipedrive company per install.** Any number of Vobiz accounts can sign
  in, but OAuth tokens for a single Pipedrive company live in
  `backend/.pipedrive-tokens.json` (mode 0600, gitignored), and every account's
  calls are logged there.
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
