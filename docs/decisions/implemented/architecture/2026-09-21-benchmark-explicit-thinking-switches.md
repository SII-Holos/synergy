# Decision Record: Preserve explicit benchmark thinking switches

Status: implemented

## Problem

Chat Completions providers expose different thinking controls. A profile accepting only `thinking.type` cannot reproduce a provider configured with `enable_thinking: false`. Treating the presence of a thinking object or the string `none` as truthy also advertises reasoning for an explicitly disabled condition.

## Decision

Model profiles accept strict boolean `enable_thinking` on Chat Completions. The gateway owns it alongside the existing reasoning and sampling parameters: remove native values, apply the frozen profile and retain effective requests and parameter overrides. Harness reasoning capability follows explicit enable/disable values instead of object truthiness. Synergy primary and helper roles resolve to the same frozen model.

The Boyue observation preset uses `bailian/deepseek-v4.1-flash`, disabled thinking, temperature 1, a 1,000,000-token context and the configured native 393,216-token output limit. It compares the `v3.0.22` release commit with the candidate. Output limits are explicit experimental conditions; a smaller historical ceiling cannot silently carry into this comparison. Its endpoint is a placeholder and credentials remain environment references. Actual support requires native CLI, tool roundtrip and retained wire acceptance; configuration validation alone is insufficient.

## Alternatives considered

**Translate every switch into `thinking.type`.** Rejected because a service need not recognize that wire field; a syntactically valid profile would not establish disabled thinking.

**Pass native parameters through unchanged.** Rejected because helper calls and native defaults could alter the declared condition. The gateway's profile-exclusive policy remains authoritative.

## Consequences

Boolean strings and numeric substitutes fail before preparation. Existing profiles retain their wire format, while disabled reasoning is correctly reflected in generated native model capabilities. Switching provider, control or evaluator requires a new experiment; historical scores and accounting remain unchanged.
