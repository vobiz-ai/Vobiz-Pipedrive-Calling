<div align="center">

# Vobiz Calling for Pipedrive

**Call your Pipedrive contacts from the browser over Vobiz, and get every answered call logged in Pipedrive as an Activity and a Call Log, with the recording attached.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 18.18+](https://img.shields.io/badge/Node-18.18%2B-339933.svg)](https://nodejs.org)

[Docs](https://www.vobiz.ai/docs/integrations/pipedrive) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

Vobiz Calling for Pipedrive is a browser softphone and a small Node.js backend
that you host yourself. Your agents sign in with a Vobiz account, place and
answer calls in a browser tab, and see the matching Pipedrive contact while
they dial. When a call's recording is ready, the backend writes the call into
Pipedrive and uploads the audio to the Call Log.

## Features

- **Click-to-call from the browser.** Type a number or use the keypad. Audio
  runs over WebRTC in the tab, so you need no desk phone and no desktop app.
- **Inbound calls.** Calls to a Vobiz number you enable ring every signed-in
  agent on that account. Accept or decline with **Enter** / **Escape**.
- **Contact lookup.** The panel looks up the number in Pipedrive as you type,
  and when an inbound call rings, and shows the person's name, email and
  organization.
- **Call logging in Pipedrive.** Each answered call becomes a done *Call*
  Activity and a Call Log, linked to the matching person.
- **Recordings.** Every call is recorded on Vobiz. The audio is uploaded to the
  Pipedrive Call Log, and the panel lists recent recordings with an inline
  player.
- **Caller-ID choice.** Pick which of your Vobiz numbers outbound calls show.
- **In-call controls.** Mute, Hold and a DTMF keypad.
- **Multiple agents and accounts.** Each agent profile gets its own SIP
  endpoint, and several Vobiz accounts can share one backend.
- **Two sign-in modes.** *Vobiz account* (Auth ID + Auth Token, set up for you
  automatically) or *SIP direct* (an existing endpoint's SIP credentials).

## How it works

```
 Agent's browser                        Your backend (this repo)            Vobiz
 ┌───────────────────────┐             ┌───────────────────────┐       ┌─────────────┐
 │ Softphone page        │──sign-in───▶│ /api/login            │──API─▶│ Application │
 │ (JsSIP over WebRTC)   │             │                       │       │ SIP endpoint│
 │                       │═══SIP / audio (WSS) ═══════════════════════▶│ registrar   │
 │ Pipedrive in a tab    │             │ /answer  ◀──webhooks──────────│ voice       │
 └───────────────────────┘             │ /recording-callback   │       └─────────────┘
                                       │        │              │
                                       │        ▼  OAuth       │
                                       │   Pipedrive API       │
                                       └───────────────────────┘
```

- You run the backend on a public HTTPS URL. It serves the softphone page and
  receives Vobiz webhooks.
- When an agent signs in, the backend creates (or reuses) an application and a
  SIP endpoint in their Vobiz account, and hands the browser fresh SIP
  credentials for that endpoint.
- The softphone registers with the Vobiz registrar over secure WebSocket.
  Audio flows between the browser and Vobiz, not through your backend.
- **Outbound:** the browser places the call. Vobiz asks your backend's
  `/answer` URL what to do, and the backend tells Vobiz to dial the customer
  from your chosen caller ID and record the call.
- **Inbound:** Vobiz asks `/answer`, and the backend rings every signed-in
  agent on the account that owns the number.
- When the recording is ready, Vobiz calls `/recording-callback`. The backend
  looks up the caller in Pipedrive, writes the Activity and the Call Log, and
  uploads the audio.
- The backend talks to Pipedrive with OAuth 2.0 tokens for one Pipedrive
  company.

## Requirements

- **A Vobiz account** with:
  - its **Auth ID** and **Auth Token**, from [console.vobiz.ai](https://console.vobiz.ai)
    under **API credentials** (the Auth Token is not your login password);
  - at least one **active, voice-enabled phone number**;
  - enough **balance** for the calls you place.
- **A Pipedrive company** where you can install apps (usually an admin), and
  access to **Developer Hub** at [developers.pipedrive.com](https://developers.pipedrive.com)
  to create the app that connects this backend.
- **A public HTTPS URL** for the backend, reachable by Vobiz and by your
  agents' browsers, for example `https://calling.example.com`.
- **Node.js 18.18 or later** (20 or 22 recommended).
- **Agents:** a current Chrome, Edge, Firefox or Safari, a microphone, and
  network access to `wss://registrar.vobiz.ai:5063`.

## Quick start

1. Clone and install:

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-Pipedrive-Calling.git
   cd Vobiz-Pipedrive-Calling
   npm install
   ```

2. Create the configuration file. It holds deployment settings only, never
   Vobiz credentials:

   ```bash
   cp backend/.env.example backend/.env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into SIGNING_SECRET
   ```

   Set at least these in `backend/.env`:

   ```ini
   PUBLIC_BASE_URL=https://calling.example.com
   SIGNING_SECRET=<the value you just generated>
   ADMIN_TOKEN=<another generated value>
   TOKEN_ENCRYPTION_KEY=<another generated value>
   ```

   If the backend is served under a path (for example
   `https://integrations.example.com/pipedrive/` behind a proxy that strips
   `/pipedrive`), include the path in `PUBLIC_BASE_URL`.

3. Start the backend (port `8092` by default):

   ```bash
   npm start
   ```

4. Expose it on your public HTTPS URL (a reverse proxy, a load balancer, or a
   named tunnel). To try it out without a domain, run `npm run tunnel` in a
   second terminal: it starts a Cloudflare quick tunnel and writes its URL to
   `backend/tunnel-url.txt`, which the backend uses when `PUBLIC_BASE_URL` and `TUNNEL_URL` are empty.
   Quick-tunnel hostnames change on every restart, so do not use them for real
   traffic.

5. Check that Vobiz can reach the answer URL:

   ```bash
   curl -s -X POST "https://calling.example.com/answer" \
     -d "From=sip:check@registrar.vobiz.ai&To=10000000000&RouteType=sip"
   ```

   You must get an XML `<Response>` (for this test, a short message and
   `<Hangup/>`). A 404 page or a tunnel warning page means calls will fail.

6. Create the Pipedrive app and connect it. See
   [Connect Pipedrive](#connect-pipedrive).

7. Open `https://calling.example.com/` in the agent's browser, sign in, allow
   the microphone, and wait for the badge to read **READY**. See
   [Sign in](#sign-in).

## Connect Pipedrive

### 1. Create the app in Developer Hub

In [Pipedrive Developer Hub](https://developers.pipedrive.com), create an app.
A private app is enough for your own company.

- **Callback URL:** `https://calling.example.com/auth/pipedrive/callback`.
  It must match the backend's redirect URI exactly (see
  `PIPEDRIVE_REDIRECT_URI` below).
- **Scopes:** turn on only what the integration uses.

  | Scope | Access | Used for |
  |---|---|---|
  | Activities (`activities:full`) | Full access | Creating the call Activity |
  | Contacts (`contacts:read`) | Read only | Finding the person by phone number |
  | Search for all data (`search:read`) | On | Fallback phone search |
  | Call logs (`phone-integration`) | On | Creating the Call Log and uploading the recording |

Copy the app's **Client ID** and **Client secret** into `backend/.env`:

```ini
PIPEDRIVE_CLIENT_ID=<client id>
PIPEDRIVE_CLIENT_SECRET=<client secret>
PIPEDRIVE_REDIRECT_URI=https://calling.example.com/auth/pipedrive/callback
```

Restart the backend.

### 2. Authorize

Connecting a company is an admin step. Open
`https://calling.example.com/admin/login` in a browser where you are signed in
to Pipedrive, enter `ADMIN_TOKEN` and the Vobiz Auth ID whose calls should be
logged to this company, and approve the app. The page then says **Connected to
Pipedrive**. To check at any time:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://calling.example.com/admin/pipedrive/companies
# {"companies":[{"companyId":"1234567","companyDomain":"yourcompany","vobizAuthIds":["MA_XXXXXXXX"],...}]}
```

Each Pipedrive company gets its own grant, stored under its company id in
`DATA_DIR/pipedrive-companies.json` with the access and refresh tokens
encrypted with `TOKEN_ENCRYPTION_KEY` (AES-256-GCM). The backend refreshes
access tokens on its own, and every connected company survives a restart.
Connecting a second company adds it beside the first; it never replaces it.

A call is logged to the company linked to its Vobiz account. A company linked
to no account is the default for accounts no company claims, as long as it is
the only unlinked one. To link an account later:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"companyId":"1234567","authId":"MA_XXXXXXXX"}' https://calling.example.com/admin/pipedrive/link
```

To disconnect, an agent signed in with a linked Vobiz account presses
**Disconnect Pipedrive** in the softphone, or the admin posts
`{"companyId":"…"}` to `/auth/pipedrive/disconnect`. An older
`backend/.pipedrive-tokens.json` is moved into the encrypted store, and
deleted, the first time the backend starts with `TOKEN_ENCRYPTION_KEY` set.

### 3. Open the softphone

The softphone is a web page served by your backend:

| URL | What it is |
|---|---|
| `https://calling.example.com/` | The softphone |
| `https://calling.example.com/agent-phone/index.html` | The same softphone, by its full path |
| `https://calling.example.com/pipedrive-app/pipedrive-cti-app.html` | The Pipedrive CTI app page. Opened directly, it redirects to the softphone; inside a frame it shows a link that opens the softphone in its own tab |

Agents keep the softphone open in its own browser tab, next to Pipedrive. The
page must stay open to receive calls.

## Sign in

The softphone has two tabs under **Sign in to Vobiz**.

### Vobiz account (recommended)

Enter your **Auth ID** (`MA_XXXXXXXX`) and **Auth Token**, choose an **Agent
Profile**, and press **Log in**. Any Vobiz account can sign in, and several
accounts can use the same backend.

On sign-in the backend:

1. Checks the Auth ID and Auth Token with Vobiz. If Vobiz rejects them, so does
   the softphone.
2. Finds or creates an application named **`Vobiz-Pipedrive-Calling`** in your
   account, with:
   - Answer URL `https://calling.example.com/answer` (POST)
   - Hangup URL `https://calling.example.com/hangup-callback` (POST)
   - Fallback URL `https://calling.example.com/fallback` (POST)

   It reuses an application whose answer URL already points at this backend,
   or the one it created earlier under that name (updating its URLs if your
   backend URL changed). It never changes any other application.
3. Finds or creates **one SIP endpoint per agent profile**, with the alias
   `pipedrive-<profile>`, attaches it to that application, and sets a new
   random SIP password that only this browser session receives.
4. Loads your account's active, voice-enabled numbers into **Choose a caller
   ID**.

The softphone then registers, and the badge turns to **READY**. The **Call**
button stays disabled until then.

**Caller ID.** Pick the number your outbound calls show from **Choose a caller
ID**. Only your account's active, voice-enabled numbers are listed, and the
backend refuses any other number.

**Agent profiles.** Each profile gets its own endpoint. Give each person their
own profile: signing in sets a new SIP password, so a second browser on the
same profile disconnects the first. Type any profile ID (letters, digits, `-`
or `_`) in the **Agent Profile** field. To suggest profiles in that field and
give them display names, copy `backend/agents.example.json` to
`backend/agents.json` (or point `AGENTS_FILE` at your own file) and edit it:

```json
{
  "priya": { "name": "Priya Sharma", "pipedriveUserId": 12345678 }
}
```

`pipedriveUserId` is optional. When set, that agent's Activities and Call Logs
are owned by that Pipedrive user. The file is read on each use, so edits apply
without a restart.

#### Enable inbound calls

Signing in does not change where your numbers route. To take inbound calls on
a number:

1. Select the number under **Choose a caller ID**. The line below shows where
   its inbound calls go now.
2. Press **Enable inbound calls on this number** and confirm.

This attaches the number to the `Vobiz-Pipedrive-Calling` application. **It
moves the number off the application it was attached to before.** The panel
names that application (by its ID) in the confirmation, so you can move it back
in the Vobiz Console later.

Inbound calls ring every agent signed in to the account that owns the number,
at the same time. The first to accept gets the call. If nobody from that
account is signed in, the caller hears a short message and the call ends.

### SIP direct

Use this tab to sign in as an existing Vobiz SIP endpoint without giving the
backend your account credentials. Enter:

- **SIP Username:** the endpoint's username (the user part of its `sip_uri`).
- **SIP Password:** the endpoint's password. It stays in the browser and is
  never sent to the backend or saved.
- **Calling From (Caller ID):** a number on the same account, in E.164 format
  (`+91XXXXXXXXXX`). Inbound calls to this number ring this softphone.

Press **Connect**. **Remember username and caller ID** keeps those two fields
(never the password) in this browser.

Because the backend holds no credentials for your account, you must point the
endpoint and the number at an application whose answer URL is your backend.

**In the Vobiz Console:**

1. **Voice → Applications:** create an application with Answer URL
   `https://calling.example.com/answer` (POST) and Hangup URL
   `https://calling.example.com/hangup-callback` (POST).
2. **Voice → Endpoints:** open your endpoint and set its **Application** to the
   new application.
3. **Phone Numbers:** open your number and set its **Application** to the same
   application.

**Or with the API:**

```bash
AUTH_ID=MA_XXXXXXXX
AUTH_TOKEN=<your auth token>
BACKEND=https://calling.example.com
API=https://api.vobiz.ai/api/v1/Account/$AUTH_ID
H=(-H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" -H "Content-Type: application/json")

# 1. Create the application. Note the app_id in the response.
curl -s -X POST "$API/Application/" "${H[@]}" -d '{"app_name":"Vobiz-Pipedrive-Calling",
  "answer_url":"'"$BACKEND"'/answer","answer_method":"POST",
  "hangup_url":"'"$BACKEND"'/hangup-callback","hangup_method":"POST"}'

# 2. Attach the endpoint, then read it back: application.app_id must be <APP_ID>.
curl -s -X POST "$API/Endpoint/<ENDPOINT_ID>/" "${H[@]}" -d '{"app_id":"<APP_ID>"}'
curl -s "$API/Endpoint/<ENDPOINT_ID>/" "${H[@]}"

# 3. Attach the number (+91XXXXXXXXXX becomes %2B91XXXXXXXXXX).
curl -s -X POST "$API/numbers/%2B91XXXXXXXXXX/application" "${H[@]}" -d '{"application_id":"<APP_ID>"}'
```

Keep `app_id` as a string. It is too long to pass through a JavaScript number
without losing digits.

**Not available in SIP direct:** the number list and caller-ID dropdown,
**Enable inbound calls**, Pipedrive contact lookup in the panel, the
recordings list, and recordings in Pipedrive. Calls are still logged to
Pipedrive, without the recording. Webhook signatures cannot be checked for
these calls, so SIP direct does not work with `VOBIZ_WEBHOOK_SIGNATURES=require`.

## Using it

### Outbound calls

1. Pick a caller ID under **Choose a caller ID**.
2. Type the number in E.164 format (`+91XXXXXXXXXX`) or use the keypad. As you
   type, the panel shows the matching Pipedrive contact.
3. Press **Call** (or **Enter**). While connected, use **Mute**, **Hold** and
   the keypad for DTMF. Press **Hang up** to end the call.

### Inbound calls

An incoming call shows the caller's number and the matching Pipedrive contact.
Press **Accept** (**Enter**) or **Decline** (**Escape**). Keep the softphone
tab open to receive calls.

### What is written to Pipedrive

When Vobiz reports that a call's recording is ready, the backend writes two
records. They are owned by the agent's `pipedriveUserId` when the profile has
one, and otherwise by the Pipedrive user who authorized the app:

- **An Activity** of type *Call*, marked done, with:
  - subject `Vobiz Outbound call - +91XXXXXXXXXX` (or `Inbound`);
  - the duration, rounded up to the minute;
  - a note with the call UUID, direction, from and to numbers, agent, duration,
    hangup cause and a **Listen** link to the recording.
- **A Call Log**, with the outcome (`connected`, `busy` or `no_answer`), from
  and to numbers, start and end time, duration, and the recording audio
  uploaded to it.

Both are linked to the Pipedrive person whose phone number matches the other
party (the number dialled, or the inbound caller). If no person matches, the
records are created without a person. When that person has exactly one open
deal, the records are linked to that deal too.

Calls that are not answered produce no recording, so they are not logged.

### Recordings

Every call is recorded on Vobiz as MP3. You can play it in three places:

- **In Pipedrive, on the Call Log.** The audio is uploaded there, so it stays
  playable for as long as the Call Log exists.
- **From the Activity note's Listen link.** This link is signed and expires
  after 15 minutes by default (`RECORDING_URL_TTL_SECONDS`).
- **In the softphone, under Call recordings.** It lists your account's 10 most
  recent recordings, each with a fresh signed link.

### Backfilling missed calls

To log recent calls that were not written (for example while Pipedrive was not
connected), run the following while the backend is running. It writes your
account's 10 most recent CDRs to Pipedrive:

```bash
npm run fetch-cdr -- --auth-id MA_XXXXXXXX --auth-token <your auth token>
```

It does not check for calls already logged, so it can create duplicates. It
also signs in as the `admin` profile, which disconnects a browser signed in as
`admin` on that account.

## Configuration reference

All settings go in `backend/.env` (or another file named by `VOBIZ_ENV_FILE`).
Variables already set in the environment take precedence. No Vobiz Auth ID,
Auth Token, SIP credentials or numbers go here.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Yes | `TUNNEL_URL` | Public HTTPS base URL of the backend, including any path prefix (e.g. `https://integrations.example.com/pipedrive`). Applications are pointed at `<this>/answer`, webhook signatures are checked against it, and the admin cookie is scoped to its path. Set it before anyone signs in |
| `TUNNEL_URL` | No | contents of `backend/tunnel-url.txt` | Used when `PUBLIC_BASE_URL` is empty |
| `ADMIN_TOKEN` | Yes, to connect Pipedrive | — | Secret for the admin routes: connecting, linking, listing and disconnecting Pipedrive companies. Unset, connecting is off |
| `TOKEN_ENCRYPTION_KEY` | Yes, to connect Pipedrive | — | 32 bytes (64 hex characters or base64) that seal the stored Pipedrive tokens. Keep a copy: without it, every company must be connected again |
| `PORT` | No | `8092` | Port the backend listens on |
| `SIGNING_SECRET` | Yes in production | random per start | Key for signing recording links. If unset, every link stops working when the backend restarts |
| `RECORDING_URL_TTL_SECONDS` | No | `900` | How long a recording link stays valid, in seconds |
| `DATA_DIR` | No | `backend/data` | Where `endpoints.json` (endpoint IDs and SIP usernames) is stored |
| `VOBIZ_WEBHOOK_SIGNATURES` | No | `verify` | `verify`: reject a wrong signature, accept unsigned callbacks. `require`: reject anything without a valid signature (not compatible with SIP direct). `off`: no check |
| `VOBIZ_API_URL` | No | `https://api.vobiz.ai` | Vobiz API base URL |
| `VOBIZ_REGISTRAR` | No | `registrar.vobiz.ai` | SIP registrar the softphone registers with (`wss://<this>:5063/`) |
| `PIPEDRIVE_CLIENT_ID` | Yes | — | Client ID of your Pipedrive app |
| `PIPEDRIVE_CLIENT_SECRET` | Yes | — | Client secret of your Pipedrive app |
| `PIPEDRIVE_REDIRECT_URI` | No | `<PUBLIC_BASE_URL>/auth/pipedrive/callback` | OAuth callback. Must match the app's Callback URL exactly |
| `PIPEDRIVE_TOKEN_STORE` | No | `DATA_DIR/pipedrive-companies.json` | Where the encrypted per-company Pipedrive grants are stored |
| `ALLOWED_ORIGINS` | No | — | Extra browser origins allowed to call the backend, comma separated. `https://*.pipedrive.com` and `localhost` are always allowed |
| `PIPEDRIVE_ALLOW_API_TOKEN` | No | `0` | Set to `1` to use a personal API token instead of OAuth. OAuth takes priority when connected |
| `PIPEDRIVE_API_TOKEN` | No | — | Personal API token, used only with `PIPEDRIVE_ALLOW_API_TOKEN=1` |
| `PIPEDRIVE_API_URL` | No | `https://api.pipedrive.com/v1` | API base for the personal-token mode. OAuth uses the company domain Pipedrive returns |
| `AGENTS_FILE` | No | `backend/agents.json` | Agent profiles offered in the softphone, with optional display names and `pipedriveUserId`. Optional; any typed profile ID works without it |
| `ALLOW_MOCK` | No | `0` | Development only. `1` returns clearly labelled sample CRM data when Pipedrive is not connected. It never bypasses sign-in |
| `VOBIZ_ENV_FILE` | No | `backend/.env` | Path of the configuration file to load |

`npm run fetch-cdr` and the live checks also read `AUTH_ID`, `AUTH_TOKEN` and
(live checks only) `CALLER_ID` from the environment at run time.

## Deploying to production

- **Use HTTPS on a stable hostname.** Vobiz must reach `/answer`,
  `/fallback`, `/dial-status`, `/recording-callback` and `/hangup-callback`,
  and browsers only allow the microphone on HTTPS (or `localhost`).
- **Run exactly one backend instance.** Sign-ins, sessions and in-progress
  calls are held in memory, so they cannot be shared across instances.
- **Keep the data on persistent storage:** `DATA_DIR`, which holds the
  encrypted Pipedrive store (`PIPEDRIVE_TOKEN_STORE`). Files are written with
  mode `0600`. Keep `TOKEN_ENCRYPTION_KEY` and `ADMIN_TOKEN` in a password
  manager as well as in `.env`.
- **Set `SIGNING_SECRET`** to a fixed random value, so recording links survive
  restarts.
- **Set `PUBLIC_BASE_URL`** to the production URL (with its path prefix, if
  any) before anyone signs in. If you
  change it later, restart and have each account sign in again; that updates
  the `Vobiz-Pipedrive-Calling` application. Update the Pipedrive app's
  Callback URL and `PIPEDRIVE_REDIRECT_URI` yourself.
- **Turn on strict webhook signatures.** After one call, look for
  `[signature] valid Vobiz signature` in the log, then set
  `VOBIZ_WEBHOOK_SIGNATURES=require` (unless you use SIP direct).
- **Restrict who can reach the backend** if only your company should use it.
  Any Vobiz account can sign in. Link every account to its Pipedrive company
  when you connect it, so no account's calls fall through to a default company.
- **Run it under a process manager** (systemd, PM2, a container) that restarts
  it on failure. After a restart, agents sign in again.
- **Pipedrive app:** set the production Callback URL in Developer Hub and
  connect each company from `/admin/login`.

## Security and privacy

- **Your Auth Token never leaves the server and is never stored on disk.** The
  browser sends it once at sign-in and gets an opaque session token back. The
  backend keeps the Auth Token in memory only, and never logs it or returns it.
- **What is stored on disk:** endpoint IDs and SIP usernames in
  `DATA_DIR/endpoints.json`, and one Pipedrive OAuth grant per company in
  `DATA_DIR/pipedrive-companies.json`, its tokens encrypted with
  `TOKEN_ENCRYPTION_KEY`. Both are mode `0600`. No SIP passwords, no Vobiz
  tokens and no plaintext Pipedrive tokens are written to disk.
- **What the browser receives:** a session token (valid for 12 hours), the SIP
  username and password for its own endpoint, your account's numbers, and
  signed recording links. SIP direct keeps the SIP password in the browser
  only.
- **SIP passwords rotate.** Each sign-in sets a new random password on the
  agent's endpoint.
- **Recording links carry no credentials.** They are signed, expire after
  `RECORDING_URL_TTL_SECONDS`, and work for one recording of one account only.
  The backend fetches the audio from Vobiz itself.
- **Every route that places calls, reads recordings, or reads or writes CRM
  data requires a signed-in session**, and acts only on that session's
  account.
- **Caller IDs are limited** to the signed-in account's own active numbers.
- **The backend changes only its own resources** in your Vobiz account: the
  `Vobiz-Pipedrive-Calling` application and its `pipedrive-*` endpoints. A
  number is moved only when you press **Enable inbound calls**.
- **CORS is an allowlist:** your Pipedrive domain (`https://*.pipedrive.com`),
  `localhost`, and anything in `ALLOWED_ORIGINS`.
- **Webhook signatures** from Vobiz are checked with the Auth Token of the
  account each call belongs to.
- **Only the softphone is served over HTTP.** The configuration file, token
  store and source code are not reachable.

See [SECURITY.md](SECURITY.md) for what the integration does not protect
against, and how to report a vulnerability.

## Troubleshooting

The backend log shows each step of a call. For outbound and inbound calls, the
most useful line is:

```
[DIAL RESULT] status=completed ring=true cause=NORMAL_CLEARING bleg=<uuid> dur=42
```

If `bleg` reads `(none — B leg never originated)`, Vobiz never reached the
other party.

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in says *Vobiz did not accept that Auth ID and Auth Token* | Wrong credentials, or the console login password was used | Copy both values from Console → **API credentials** |
| Sign-in says *This server has no public URL (TUNNEL_URL)* | `PUBLIC_BASE_URL` and `TUNNEL_URL` are empty | Set `PUBLIC_BASE_URL` and restart |
| Badge shows *Registration failed* | Account mode: the same agent profile signed in elsewhere, which changed the SIP password. SIP direct: wrong username or password | Sign in again, one person per profile. For SIP direct, use the user part of the endpoint's `sip_uri` |
| Badge stays on *Connecting…* | The backend is unreachable, or the network blocks `wss://registrar.vobiz.ai:5063` | Check the backend log and the agent's firewall |
| Outbound call: you hear *This phone is not signed in* | The backend restarted and lost the sign-ins | Sign in again |
| Outbound call fails at once, `bleg=(none…)` in the log | The destination is unreachable, the caller ID is not on the account, or the balance is too low | Check the number format, the caller ID and the balance |
| Outbound call: you hear *This Vobiz account has no phone number to call from* | The account has no active, voice-enabled number | Buy or activate a number, then sign in again |
| Nothing at all reaches the backend (no `[/answer]` in the log) | `PUBLIC_BASE_URL` is stale, or the endpoint is not attached to the application (sign-in log says `NOT bound`) | Fix `PUBLIC_BASE_URL`, restart and sign in again. For SIP direct, attach the endpoint yourself |
| Inbound calls never ring the softphone | The number is not attached to the integration's application | Select the number and press **Enable inbound calls on this number** |
| Inbound caller hears *no one is available* | Nobody from the account that owns the number is signed in | Keep at least one agent signed in |
| Log shows `[signature] INVALID` and Vobiz gets `403` | `PUBLIC_BASE_URL` does not match the URL Vobiz is calling (check the path prefix) | Set `PUBLIC_BASE_URL` to the exact public URL, restart, and sign in again |
| No Activity or Call Log in Pipedrive | No Pipedrive company is linked to this Vobiz account, or the call was not answered | Check `GET /admin/pipedrive/companies` (admin). Unanswered calls are not logged |
| Activity is not linked to a person | No Pipedrive person has that phone number | Add the number to the person in Pipedrive |
| Listen link says *invalid or has expired* | The link is older than `RECORDING_URL_TTL_SECONDS`, or the backend restarted without a fixed `SIGNING_SECRET` | Play the audio on the Call Log, or from the softphone's recordings list |
| Listen link says to sign in again | The backend restarted and holds no credentials for that account yet | Sign in to the softphone with that account, then reopen the link |
| `/auth/pipedrive` says *Admin sign-in required* | Connecting is an admin step | Sign in at `/admin/login` with `ADMIN_TOKEN` (see [Authorize](#2-authorize)) |
| `/auth/pipedrive` says *TOKEN_ENCRYPTION_KEY is not set* | No key to seal the grant with | Set `TOKEN_ENCRYPTION_KEY` and restart |
| Activities are owned by the wrong Pipedrive user | The profile has no `pipedriveUserId`, or a wrong one | Set the agent's Pipedrive user ID in `agents.json` |
| OAuth callback says *Authorisation rejected* | The approval took longer than 10 minutes, or the backend restarted during it | Start again from `/admin/login` |

## Limitations

- **Sign in again after every backend restart.** Sign-ins live in memory.
  Until someone from an account signs in again, that account's calls get a
  short message and hang up, and its recording links ask you to sign in.
- **Run one backend instance.** State is in memory and cannot be shared.
- **One Pipedrive company per backend.** Every signed-in Vobiz account's calls
  are logged to that company.
- **Unanswered calls are not logged.** Logging happens when the recording is
  ready, and an unanswered call has none. `npm run fetch-cdr` can backfill,
  without de-duplication.
- **A call is linked to a deal only when the contact has exactly one open
  deal.** With several open deals, link the Activity by hand.
- **One browser per agent profile.** Signing in on a second browser rotates
  the SIP password and disconnects the first.
- **The softphone runs in its own browser tab.** It does not yet run as an
  embedded Pipedrive panel or floating window, and it is not listed on the
  Pipedrive Marketplace.
- **SIP direct** has no recordings, no number list, no contact lookup, no
  **Enable inbound calls**, and does not work with
  `VOBIZ_WEBHOOK_SIGNATURES=require`.
- **No call transfer.**

## Development

```bash
npm test          # offline test suite: no credentials, no network
```

Live checks run against a running backend and your real Vobiz and Pipedrive
accounts. They take the Vobiz account from the environment, never from
`.env`, and report PASS / FAIL / SKIP:

```bash
AUTH_ID=MA_XXXXXXXX AUTH_TOKEN=<token> npm run test:live   # all checks
npm run test:answer       # the public answer URL returns <Dial><Number>
npm run test:inbound      # writes ONE test Activity + Call Log to Pipedrive
npm run test:recording    # recording-link checks
npm run test:sync         # CDR backfill
```

Project layout:

```
backend/
  server.js             HTTP server: webhooks, softphone API, Pipedrive sync
  vobiz-accounts.js     sign-in, application and endpoint setup, call routing per account
  pipedrive-oauth.js    Pipedrive OAuth 2.0: authorize, token exchange, refresh
  vobiz-signature.js    Vobiz webhook signature check
  static-files.js       serves agent-phone/ and pipedrive-app/ only
  fetch-cdr.js          CLI: list recent CDRs and recordings, optionally sync them
  tunnel.js             Cloudflare quick tunnel for trying it out
  test-pipedrive-sync.js  live checks
  test/                 offline tests (npm test)
  .env.example          configuration template
  agents.example.json   agent profile names
agent-phone/
  index.html            the softphone
  softphone.js          panel logic
  vobiz-sip.js          SIP layer: register, dial, answer, mute, hold, DTMF
pipedrive-app/
  pipedrive-cti-app.html  Pipedrive CTI app page; opens the softphone
```

## Support

- Vobiz documentation: https://www.vobiz.ai/docs
- This integration: https://www.vobiz.ai/docs/integrations/pipedrive
- Issues: https://github.com/vobiz-ai/Vobiz-Pipedrive-Calling/issues
- Email: support@vobiz.ai (security reports: see [SECURITY.md](SECURITY.md))

## License

[MIT](LICENSE)
