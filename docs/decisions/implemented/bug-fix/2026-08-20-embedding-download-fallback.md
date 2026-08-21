# Decision Record: Embedding model download auto-fallback and TTFB timeout

Status: implemented

## Problem

The zero-config local embedding default downloads `Xenova/all-MiniLM-L6-v2` from huggingface.co on first use. Two failure modes made this default unreliable in networks where huggingface.co is unreachable (e.g. behind a proxy or in regions that block it):

- A download against an unreachable host hung indefinitely at 0% with no error message — `env.fetch` never rejected, so the load never failed and never recovered. The only remedy was killing the process.
- There was no automatic route to an alternative source, so the zero-config default simply did not work in such networks; users had to discover and manually set `embedding.local.source` to `"hf-mirror"`.

## Decision

Two coordinated changes in the local embedding runtime:

1. **30s time-to-first-byte (TTFB) timeout on remote downloads.** `installLocalFileFetch` wraps `runtime.env.fetch` so remote requests go through `fetchRemoteWithTimeout()`, which aborts if response headers do not arrive within 30 seconds. The abort surfaces a clear error naming the likely cause (network/proxy) and the remedy (HTTPS_PROXY or an alternative source). The timeout is TTFB-only: once headers arrive, the body streams at its own pace. The wrapper is installed only on `runtime.env.fetch` (the `@huggingface/transformers` download path); `globalThis.fetch` — used by LLM provider calls — is untouched, so provider calls keep their own timeout behavior.

2. **Three-tier auto-fallback chain for the default source.** When `source === "huggingface"` (the default) and the pipeline download fails, `loadLocalExtractor()` reconfigures the runtime to `hf-mirror.com` and retries the pipeline once; if the mirror also fails, it falls back to the disk cache (`local_files_only: true`) and loads offline if cached. Explicit `"hf-mirror"` and `"custom"` sources skip the auto-fallback and go straight to the disk cache on failure, preserving the user's explicit choice. The failure `loadState` records `originalSource`/`originalRemoteHost`, so `status()` reports the configured source when the load failed; a successful mirror fallback reports the source that actually served the model (`"hf-mirror"`).

Coverage: `embedding-local.test.ts` asserts the 3-call fallback chain (huggingface → hf-mirror → disk cache) and the 4-call retry-after-failure sequence; the full embedding suite (local, standalone, library API) passes at head.

## Alternatives considered

- **Add only the timeout, no fallback** — rejected: the timeout converts a hang into a hard failure, but the zero-config default would still fail in blocked networks; the fallback is what keeps the default working.
- **Add only the fallback, no timeout** — rejected: with both remote hosts unreachable, the first pipeline attempt still hung indefinitely before the disk-cache fallback could run; the timeout is what bounds the retry chain.
- **Retry every failed source including explicit `hf-mirror`/`custom`** — rejected: a user who explicitly configured a source chose it; silently switching to another host after their choice failed would be surprising, and `custom` origins may be private deployments that should not be bypassed.
- **Persist the last-good source across restarts** — rejected: adds config-mutation semantics to a runtime fallback; out of scope for the fix, though the per-process behavior is a known limitation in blocked networks (each restart pays one timeout before the mirror succeeds).
- **Apply the timeout to `globalThis.fetch`** — rejected: LLM provider calls share that path and have their own timeout/retry contracts; the wrapper is scoped to the transformers download path to avoid changing provider behavior.

## Consequences

- The zero-config default now works in networks where huggingface.co is blocked: one timeout (30s) then automatic mirror download, or offline from disk cache if the model is already cached.
- A completely unreachable environment fails within ~60s (two 30s TTFB timeouts: huggingface + hf-mirror) instead of hanging forever, with a diagnostic error message.
- `status()` semantics split by outcome: failed loads report the configured source; successful mirror fallbacks report `"hf-mirror"` — callers should treat `source` as "configured or effectively-used" rather than strictly configured.
- The timeout is TTFB-only; a connection that stalls mid-body still hangs at a fixed progress percentage (unchanged from before, now documented).
- Each process restart in a blocked network repeats the 30s timeout before the mirror fallback succeeds; no last-good source is remembered.
