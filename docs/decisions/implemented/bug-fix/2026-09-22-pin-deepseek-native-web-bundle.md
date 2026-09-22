# Decision Record: Pin the verified DeepSeek web bundle during native preparation

Status: implemented

## Problem

The native DeepSeek matrix stopped during dependency installation on 2026-09-22. Although the harness entry package was pinned to `0.1.5-rc.1`, its caret range selected `dsh-web-app@0.1.5-rc.3`, which required the unavailable `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`. Two CI attempts and an isolated Linux npm installation reproduced the same `ETARGET` failure before model execution.

## Decision

For the exact `deepseek@0.1.5-rc.1` experimental condition, use an npm override to retain `@deepseek-ai/dsh-web-app@0.1.5-rc.1`. Record the override in the prepared-artifact identity and generated manifest; retain the resolved lock as before. Explicitly selected other harness versions and other harness families do not inherit this exception. Reassess and remove it when upgrading the verified DeepSeek pin.

Provenance: [npm dependency overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides) defines the root-manifest mechanism. The observed failing package range came from npm preparation logs and the published `dsh-web-app` manifest. Local adaptation: scope the override to this one verified harness release rather than change the declared CLI version or ignore installation failures.

## Alternatives considered

- Retrying cannot install a package version that has not been published.
- Skipping the native matrix would conceal a broken supported integration.
- Pinning all package publication times also rejected dependencies published after the root package; it does not describe a complete release.
- Overriding every DeepSeek dependency changes more of the experimental condition than the failing web bundle requires.

## Consequences

Cold preparation no longer selects the incomplete web bundle. The prepared-artifact key changes, so old immutable artifacts and historical experiments retain their original identities. Other transitive dependencies remain governed by the resolved lock; this is not a blanket freeze of the upstream monorepo. [Preparation contracts](../../../../benchmark/test/test_prepare.py) cover default and explicit versions, and the native matrix retains both model protocols and independent model profiles.
