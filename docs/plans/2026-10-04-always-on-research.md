# Always-on research MVP implementation plan

**Goal:** One employee owns a recurring public-source research responsibility, remembers prior results, reports changes, and resumes after worker restart.

**Architecture:** A detached local Node worker owns scheduling and bounded read-only collection. Harness headless analyzes supplied source text with tools disabled; each run receives persisted prior memory. The existing authenticated plugin UI configures responsibilities and displays results, changes, notices and worker health. JSON locks protect short state transitions; no lock is held during network/model work. Run ownership and interrupted-run recovery prevent duplicate execution.

**Tech Stack:** Node built-ins, existing Cordis/React integration, installed Harness headless JSON protocol.

## Decisions

- Selected scenario: public webpages/news research, confirmed by user.
- Independent worker is preferred over app-only timers (stops with the UI) or a new cloud deployment (not yet configured).
- Local computer must remain running. No cloud/offline-computer claim; worker survives closing the desktop app, starts with the plugin, and has explicit CLI start/stop.
- No predefined real target enabled. User supplies sources and explicitly starts work. Default minimum interval 15 minutes; daily model-call cap and 120-second model timeout.
- Public HTTP(S) only, bounded response sizes and redirects, pin validated public DNS addresses. Reject private/local targets. Source contents are evidence, not instructions.
- No shell, filesystem, web or publishing tools exposed to the research model; model output is plain text and never executable.
- Pause/cancel, retry/backoff, durable latest memory, bounded history and change/error notices. Only one responsibility enabled at a time in v1.

## Steps and acceptance

1. Implement store/control/claim/recovery with temporary-directory tests: persist goals, exclusive run claim, pause, schedule, restart recovery, retries and daily caps.
2. Implement public-source collector and headless adapter: SSRF/redirect/timeout/size tests, machine protocol validation, missing runtime/auth surfaced as failures. Deterministic tests explicitly use fixtures; one real headless smoke validates installed runtime.
3. Implement detached worker and CLI: test process restart and duplicate worker ownership, unchanged sources skip model calls, changed sources produce results and notices. Never claim a failed run succeeded.
4. Add authenticated responsibility endpoints and React management/result UI; retain current office/composer behavior. Test forms and request contracts.
5. Run all regressions plus isolated end-to-end acceptance: baseline → unchanged → changed → failure → recovery → pause → restart. Document exact commands, outcomes and boundaries.
6. Restart desktop and verify new entry, empty/paused state, worker health and existing composer. Leave no active demonstration schedule or real test content.

## Completed verification

All six steps completed on 2026-10-04. `npm test` passes 112 checks: 32 team contracts, 42 content smoke checks and 38 Node test cases. Process tests use real child processes with clearly identified model fixtures. HTTP transport tests caught and fixed an oversized-response completion race; pooling is disabled and rejection precedes connection teardown. Headless requires a completed turn, successful exit and nonempty final text.

The installed Harness headless successfully analyzed a real public webpage and returned a Chinese brief plus session ID/token usage. Native desktop inspection confirmed the composer, office research section, online badge and creation form. Worker PID 42334 stayed alive and updated its heartbeat after full desktop exit, and was reused on desktop reopen; it was subsequently restarted gracefully to load final fixes. No real responsibility was created or enabled. The package includes its worker and headless overlay. See ../always-on-research.md for acceptance details and remaining limits.
