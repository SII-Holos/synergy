# Provider catalogs, options and probes

Embedded hosts keep stable model inventory in `ProviderCatalogSource`. For credentials or SDK context tied to an accepted invocation, register `ProviderRequestSource` before composition is sealed. Validate the detached root user metadata there; keep keys out of model options and prompts. Test real `LLM.prepare()` plus worker-plan serialization, concurrent invocation isolation, cancellation and authorization failure. SDK factories consume the ephemeral `hostRequest` context without persisting it.

Keep bundled catalog imports lazy at the lifecycle boundary. An installed source host with an exclusive catalog must open, query providers and close without evaluating dependency macros or fetching models.dev. Exercise an actual `node_modules` source installation in addition to workspace tests, and include the selected backend's native resources.

## Direct AI SDK Calls

`packages/cli/src/setup/config.ts` uses `generateText()` for a live provider capability probe before normal agent/session orchestration is appropriate. Keep direct AI SDK usage limited to such bootstrap/provider plumbing or the implementation of the shared `LLM` layer. Product inference should not bypass provider transforms, configured roles, plugin hooks, telemetry, timeouts, or output policy. Bootstrap probes that reach a managed-inference endpoint must pass through the same per-request header gate as normal turns (`ProviderSessionHeader.forRequest` with the resolved provider options), because the provider cannot distinguish a probe from a conversation.

Saved-connection probes belong to `ProviderConnection.testConnection()`. Preserve the configured SDK, profile, endpoint and managed-inference headers, independent validation recording and caller cancellation. Verify wrong credentials against an actual HTTP endpoint, zero Session creation, bounded error categories without remote bodies, and one physical request without credential-recovery replay.

## External Model Catalogs

Separate external catalog metadata from explicit user configuration. Allow additive external price fields at nested tier boundaries while retaining numeric validation and raw provenance; preserve the existing configuration acceptance rules, including strict nested rate fields. Exercise damaged individual entries, complete-catalog failure with cache preservation, cold startup, actual CLI exit/output, and the bundled runtime. Pair the pinned snapshot with focused upstream-shape fixtures, since a valid pinned snapshot cannot detect later additive fields. Follow [Service and model directory](../../../../docs/reference/configuration-layout.md#service-and-model-directory) for runtime acceptance and refresh behavior.

## Provider Option Compatibility

Choosing the same AI SDK package proves only transport and wire-protocol compatibility. It does not prove provider options, thinking/reasoning controls, effort levels, tool semantics, or cache behavior are compatible with the official provider using that package.

Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility. When adding automatic model variants or default provider options, derive them from what the real provider contract supports through the current SDK and transport. If the SDK cannot express the provider's reasoning semantics without loss, omit automatic parameters and rely on the provider default. Do not guess, clamp, translate, or apply official-provider thinking/effort semantics to a third-party service merely because it reuses that provider's wire protocol. Users can still add explicit model `variants` in config to override automatic defaults.

When a provider requires a per-request header derived from the conversation (for example OpenCode Go's `x-opencode-session`), add it through the per-call headers layer gated by the resolved endpoint (`ProviderSessionHeader`), never through provider creation options or a global header map on the SDK package. Provider-creation headers bypass the conversation boundary: language-model instances are cached across sessions, and a gate on the SDK package alone would disclose conversation ids to every service reusing that package. Resolve the endpoint the SDK will actually use (model options beat provider options; the catalog API URL is only the fallback) and scope the disclosure to that endpoint with exact host and path matching.
