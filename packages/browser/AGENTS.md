# Browser Protocol Package Rules

These rules apply to the private `@ericsanchezok/synergy-browser` workspace package. Root `AGENTS.md` and [Browser runtime](../../docs/architecture/browser-runtime.md) still apply.

## Ownership

- This package owns strict Protocol v2 schemas and types, the transport-independent CDP controller, structured locators and errors, navigation leases, redaction, staging, and filename safety.
- It does not own Synergy sessions, persistence, routes, permissions, the network gateway, Electron lifecycle, or Web presentation state.
- Keep protocol unions strict, versioned, bounded, and backend-neutral. Native, WebRTC, and Playwright must share command and result semantics without adapters or fallback protocols.
- Owner keys are encoded here, but the server is their canonical source for clients. Do not derive client owner identity from route directories.
- Keep Chromium responsible for webpage network security. Do not introduce IP ranges, DNS policy, localhost port lists, or presentation-specific navigation behavior here.

## Verification

Run:

```bash
bun run typecheck
bun run test
bun run build
```

Regenerate the SDK when an exported schema is exposed through server OpenAPI, then run the affected core, App, and Desktop tests.
