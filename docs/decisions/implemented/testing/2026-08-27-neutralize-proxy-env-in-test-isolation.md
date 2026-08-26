# Decision Record: Neutralize proxy env vars in test isolation

Status: implemented

## Problem

CI runs of `packages/synergy` failed intermittently: `test/tool/arxiv-download.test.ts` (all 12 cases) and other suites that fetch from local `Bun.serve` servers returned `HTTP 404`. The tests pass in isolation locally and in Coverage, but failed in the Test job — on dev-branch CI runs since 2026-08-22, on unrelated PRs, and twice on this PR. The failures were not caused by any code change.

Root cause: Bun 1.3.x `fetch()` reads `HTTP_PROXY`/`HTTPS_PROXY` per request with no built-in loopback bypass (oven-sh/bun#39352), unlike curl/Node. CI runners configured with proxy environment variables route loopback requests to the proxy, which answers 404, so local test servers become unreachable.

## Decision

Neutralize proxy environment variables in both test isolation paths:

- `script/test-env.ts` (`createIsolatedTestEnv`, used by `test:ci` and `test:coverage` spawn orchestrators): delete `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy`/`ALL_PROXY`/`all_proxy` from the spawned child environment and pin `NO_PROXY=localhost,127.0.0.1,[::1],0.0.0.0` (both cases).
- `test/preload.ts` (in-process `bun test` entry): assign empty strings to the proxy variables (Bun's native env loader only sees assignments, not `delete`) and pin the same `NO_PROXY`.

The fix mirrors Bun's own test hygiene (`clearProxyEnv` in oven-sh/bun#37439) and covers both execution paths, so a proxied host cannot hijack loopback test-server fetches.

## Alternatives considered

- **Fix only `arxiv-download.test.ts`** — rejected: the failure mode is shared by every suite that fetches from a local `Bun.serve` server (holos, proxy, plugin registry, MCP OAuth, config import), and the root cause is environmental, not per-test.
- **Skip/filter arxiv tests on proxied hosts** — rejected: hides real regressions and leaves the rest of the local-server suites exposed.
- **Rely on GitHub-hosted runners never setting proxy vars** — rejected: dev-branch CI and this PR already failed on hosted runners; the environment is not under repo control and the fix must be robust to any host.

## Consequences

Test child processes and preload paths now bypass proxies for loopback traffic deterministically. Suites that intentionally exercise proxy behavior (`test/provider/proxy.test.ts`, `models-offline.test.ts`) construct their own explicit env/proxy options and are unaffected because they pass explicit `proxy`/`noProxy` options or spawn with their own env. CI Test jobs no longer fail from host proxy configuration.
