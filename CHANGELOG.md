# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `backend/.env`, the OAuth token store and the source tree were readable over
  HTTP (`GET /backend/.env`, `GET /../backend/.env`). Static files are now
  served from `agent-phone/` and `pipedrive-app/` only.
- Sign-in accepted the configured Auth ID with any token, and any valid pair
  for another Vobiz account; either way the session received the SIP password.
  Sign-in now requires this server's exact credentials.
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
