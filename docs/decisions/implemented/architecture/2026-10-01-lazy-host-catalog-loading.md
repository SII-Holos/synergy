# Decision Record: Load the product catalog only when selected

Status: implemented

## Problem

Harness source packages installed under node_modules evaluated the models.dev macro while importing lifecycle or configuration. Bun rejects dependency macros, including when the host supplies an exclusive catalog and never requests the product catalog.

## Decision

Remove the unused configuration import and load catalog refresh services only in the default product path. ProviderCatalog owns shutdown of its lazily loaded ModelsCatalog. Hosts with an exclusive catalog can open, query providers and close installed source packages without evaluating a bundled catalog or fetching models.dev.

## Alternatives considered

Building the entire product to consume an exclusive host catalog adds unrelated distribution requirements. Replacing the macro or copying its model catalog into hosts introduces another catalog authority.

## Consequences

The default product keeps catalog subscriptions, refresh and shutdown. Installed-source coverage exercises the actual public lifecycle and a real isolated SQL store, and rejects any catalog fetch. Hosts must still supply all required model inventory explicitly.
