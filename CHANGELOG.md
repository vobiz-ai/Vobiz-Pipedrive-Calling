# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — agent profiles, panel text, Pipedrive disconnect

- The Agent Profile picker is filled from `agents.json` via `GET /api/agents`
  (ids and names only) and accepts a typed new id; no names are hard-coded.
- `pipedriveUserId` in `agents.json` sets the Activity and Call Log owner.
- Calls are linked to the contact's deal when it has exactly one open deal.
- Panel FAQ describes the real call flow; "Disconnect Pipedrive" button added.
- The CTI page says it opens the softphone in its own tab.
- Removed the unused `PIPEDRIVE_COMPANY_DOMAIN` setting.

### Documentation

- README rewritten as a customer setup and operations guide: Pipedrive app
  and scopes, both sign-in modes, inbound, what is logged, configuration
  reference, production checklist, troubleshooting and limitations.

### Changed — any Vobiz account can sign in

- Sign-in accepts any Vobiz account: the Auth ID and Auth Token are verified
  with Vobiz (`GET /numbers`), not compared with values in `.env`. Several
  accounts can use one backend at once.
- Per sign-in provisioning: this integration's application is found (by
  `answer_url`, or its own name) or created in that account, and one SIP
  endpoint per (account, agent profile) is found (by alias) or created, bound
  with `{"app_id":"<id>"}` (verified by GET; documented integer form as the
  fallback), and given a fresh random SIP password. Endpoint ids and usernames
  are kept in `backend/data/endpoints.json` (0600, gitignored); no passwords or
  tokens.
- "Enable inbound calls" attaches a number to the integration's application,
  only when asked.
- Webhooks are routed per account: outbound by SIP user, inbound by
  `ParentAuthID` (dialled number as fallback), ringing every signed-in agent of
  that account. Unknown calls get a polite hangup.
- Caller IDs come from the account's active, voice-enabled numbers; anything
  else is refused.
- Webhook signatures are checked with the owning account's Auth Token.
- Recording links include the Auth ID in the signed payload.
- SIP direct (typed endpoint credentials + caller ID) works with no account
  credentials on the server.
- Removed `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`,
  `VOBIZ_SIP_USER` and `VOBIZ_SIP_PASSWORD`. `fetch-cdr.js` and the live checks
  take the account as flags (`--auth-id`, `--auth-token`) or `AUTH_ID` /
  `AUTH_TOKEN` at runtime.

### Security

- `backend/.env`, the OAuth token store and the source tree were readable over
  HTTP (`GET /backend/.env`, `GET /../backend/.env`). Static files are now
  served from `agent-phone/` and `pipedrive-app/` only.
- Sign-in accepted the configured Auth ID with any token. Sign-in is now
  verified with Vobiz itself.
- Routes that place calls, read recordings, read CRM data or write to the CRM
  now require a session. `/start-call` (unauthenticated REST origination) and
  `/transfer-call` (reported success, did nothing) are removed.
- Vobiz webhook signatures are verified (`VOBIZ_WEBHOOK_SIGNATURES`).
- The SIP password is no longer saved in `localStorage`.
- `/health` no longer prints credential prefixes.

### Fixed

- Pipedrive Call Logs were never created: the request used the wrong field
  names and omitted `end_time`. Recordings are now attached to the Call Log.
- Activity durations were sent as MM:SS into an HH:MM field.
- Recording durations were read from a field Vobiz does not send.
- The Pipedrive panel page used the removed REST dialer; it now opens the
  softphone.

### Changed

- `npm test` is an offline suite that needs no credentials. The live checks
  are `npm run test:live`.

## [1.0.0] — 2026-09-20

First public release.

### Added

- Outbound calling with browser audio over WebRTC.
- Inbound calling with an Accept / Decline prompt.
- Call logging to Pipedrive, with duration and outcome.
- Recording playback behind an HMAC-signed, short-expiry link that carries no
  credentials.
- Setup, architecture and troubleshooting documentation.

### Notes

- The browser is the A leg: the panel sends the SIP INVITE and the backend
  answers `<Dial><Number>`. Originating to the customer over REST and bridging
  the agent in with `<Dial><User>` does not work — routing into a registered
  WebRTC endpoint is blocked platform-side. Inbound is the exception.
- Single-account by design in this release. See the known limitations in the
  README before deploying for more than one agent.

[1.0.0]: https://github.com/vobiz-ai/Vobiz-Pipedrive-Calling/releases/tag/v1.0.0
