# Decision Record: Separate custom model API setup from provider presets

Status: implemented

## Problem

Provider Settings offers account setup for known services, but an operator connecting a gateway has no direct way to choose its protocol or declare its model catalog. Changing an OpenAI account's endpoint does not change its Responses transport into Chat Completions. Treating a brand preset as a generic compatible endpoint therefore hides a material configuration choice.

## Decision

The provider account list exposes two peer actions: Add third-party provider opens the existing directory and account flow; Add custom model API opens a focused form for an independent provider ID, name, base URL, protocol, credential and manual model list. Custom models declare their actual context and output limits, tool calling, image input and reasoning capabilities. The form does not invent conservative capacity defaults or make network requests to verify a provider while the user edits.

Custom setup extends the existing ProviderConnection service and generated HTTP SDK. Protocol selection maps to the existing OpenAI-compatible Chat Completions, OpenAI Responses and Anthropic SDK packages. The persisted providers domain retains its existing `api`, `npm` and `models` fields; credentials continue through the existing authentication store. No brand profile is inherited, no parallel provider registry is introduced, and existing incomplete hand-authored configurations retain their previous editing rules.

Editing complete custom connections preserves model fields absent from the form, including options, headers, variants, input limits and unrelated modalities. The specialized editor retains the existing enabled-state operation so a disabled connection can be restored without editing configuration files.

Routine setup uses visible field labels, format examples inside empty inputs and a single aligned row for the base URL and protocol. Do not print architecture, credential-storage or protocol-compatibility explanations beneath the fields. Validation and incomplete-save recovery remain contextual feedback. Model titles and their remove controls share a header row rather than using offset spacing.

Provenance: DeepSeek Harness's Models setup separates catalog providers from custom model APIs; see its [versioned model-provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009/docs/user/guide/providers.md).

Local adaptation: Synergy uses two account-list actions and its existing focused settings workspace, connection service, SDK transports and credential owner. No upstream implementation code is copied.

## Alternatives considered

**Override a known provider's endpoint.** Rejected as the custom setup entry because it inherits brand-specific authentication, catalog and transport behavior, while a gateway needs an explicit protocol choice.

**A separate custom-provider configuration store.** Rejected because it would duplicate the provider, model, credential and reload semantics already shared by Settings, CLI and session execution.

**Implement only a visual prototype.** Rejected because the same form can use the current runtime's configuration primitives; a nonfunctional Save control would not establish that the proposed interaction works.

## Consequences

Known-provider setup retains its directory and subscription authentication. Custom setup is independently discoverable and persists editable model metadata without changing the on-disk schema. Manual models require the operator to supply service limits and capability facts. Model discovery and connection testing remain outside this change; no successful authentication or inference claim is made merely because a configuration was saved.
