# Decision Record: Send x-opencode-session to the OpenCode Go managed inference API

Status: implemented

## Problem

OpenCode Go (`https://opencode.ai/zen/go/v1`, models.dev provider id `opencode-go`) requires an `x-opencode-session` header carrying a stable per-conversation id on inference requests; since 2026-09-06 it errors on requests without one (https://github.com/vercel/ai/issues/20271). Synergy reaches this endpoint only through the generic models.dev catalog path: `@ai-sdk/openai-compatible` with no provider-specific profile, so no code ever adds the header and every Synergy conversation against OpenCode Go fails once the enforcement date passes.

The upstream `ai` SDK will not help: Vercel closed the request as not planned on the grounds that AI SDK does not create or manage conversations, so applications own the conversation id and must send the header themselves. The same upstream thread shows the failure is not theoretical — OpenCode Go counts thousands of affected client orgs behind the `ai-sdk/openai-compatible` user agent.

## Decision

1. **A dedicated gate, `ProviderSessionHeader`** (`packages/synergy/src/provider/session-header.ts`), decides when the header applies: the provider id is exactly `opencode-go` (only when no endpoint is known), or the resolved endpoint is the OpenCode Go endpoint. The endpoint is parsed and compared on normalized hostname and path prefix (`opencode.ai` + `/zen/go`), so lookalike hosts such as `notopencode.ai` and endpoint text smuggled into a query string never receive the id — the endpoint is the disclosure boundary. Given a session id the gate returns it verbatim as `x-opencode-session`; without one it returns a fresh `crypto.randomUUID()` per call. The non-Go OpenCode Zen endpoint (`opencode.ai/zen/v1`) gets `{}`.

2. **Per-call headers at the two live request surfaces**, not at provider construction:
   - `session/llm.ts` passes `ProviderSessionHeader.forRequest({ model, providerOptions, sessionID })` as `streamText`'s per-call `headers`, so every turn of a conversation carries that conversation's id.
   - `config/setup.ts` passes `ProviderSessionHeader.forRequest({ model, providerOptions })` (no session — one-shot UUID) to the language-model live probe's `generateText`, because the provider cannot distinguish a probe from a conversation.

   Both surfaces resolve the endpoint the SDK will actually use: model `options.baseURL` beats provider `options.baseURL`, and the catalog API URL is only the fallback — mirroring `createSDKFromSpec` precedence. A custom provider id that points at the OpenCode Go endpoint through `options.baseURL` therefore gets the header, and an override that moves requests away from it stops the disclosure. A user-pinned `x-opencode-session` header of any casing replaces the generated value instead of duplicating it (HTTP folds duplicate names into one joined value).

   Per-call headers are the only correct layer: `Provider.getLanguage` caches language-model instances for 4 hours keyed by provider/model/credential, so headers baked into provider options would pin one conversation id across every session sharing the cached instance.

3. **The Synergy session id is sent as-is** — it is already a stable, unique-per-conversation opaque string, exactly what the provider asks for ("any stable UUID per conversation").

## Alternatives considered

- **Waiting for AI SDK built-in support** — rejected: upstream explicitly declined (vercel/ai#20271 closed as not planned); waiting until 09/06 means user-visible failures.
- **Injecting into provider creation options (`createOpenAICompatible({ headers })`)** — rejected: `Provider.getLanguage` caches instances for 4 hours, so a conversation-bound id would leak across unrelated sessions sharing the cached instance, and including the session id in the cache key would fragment the cache per conversation. Per-call `options.headers` is combined with config headers by the SDK (`combineHeaders`) and is the documented escape hatch for exactly this case.
- **One fixed UUID per process** — rejected: defeats the stated purpose; the provider wants per-conversation identity for routing/optimization.
- **Sending the header to every `@ai-sdk/openai-compatible` provider** — rejected: it would disclose Synergy session ids to third-party endpoints that never asked for them. The gate exists precisely to keep the disclosure scoped to OpenCode Go.
- **Carrying the header in models.dev catalog data (provider/model `headers`)** — rejected: catalog data is static and cannot express per-session identity, and it would also flag the non-Go Zen endpoint, which does not require the header.

## Consequences

Every Synergy request to OpenCode Go now carries a stable per-conversation id, satisfying the provider's 09/06 enforcement; connection probes carry a one-shot id, which is acceptable because each probe is an independent one-shot conversation. The session id is disclosed only to `opencode.ai` endpoints, and only when the user explicitly selects that provider. Users who pin their own `x-opencode-session` through model `headers` keep full control. The gate is coupled to two OpenCode Go facts — the provider id and the `opencode.ai/zen/go` URL shape — so a provider-side rename or domain change requires updating the pattern; there is no capability negotiation to discover the requirement dynamically. The non-Go OpenCode Zen endpoint is intentionally untouched.
