## What does this PR do?

<!-- A brief description of the change. Link related issues with "Closes #123" or "Fixes #456". -->

## Why?

<!-- What problem does this solve, or what feature does it add? -->

## External sources and provenance

<!-- List papers, standards, upstream code/issues/discussions, benchmarks, experiments, or research that materially informed the implementation, plus the code locations carrying Provenance markers. Write "None" when there is no material external source. -->

## How was it tested?

<!-- What tests did you run? How can a reviewer verify the change? -->

## Checklist

- [ ] `bun run quality:quick` passes
- [ ] Relevant narrow tests pass; commands are listed in "How was it tested?"
- [ ] New or moved tests live under the owning package's `test/` directory (or the root `test/` directory for repository tests)
- [ ] `bun run package:check` passes if package exports, build output, release logic, or publishable packages changed
- [ ] `bun run workflow:check` passes if `.github/workflows/**`, GitHub Actions config, or CI helper scripts changed
- [ ] Browser capability or App bootstrap changes pass the browser crypto contract and private HTTP browser smoke
- [ ] `bun run secrets:check` passes locally or CI Gitleaks covers the change if auth, provider, channel, config, or credential examples changed
- [ ] SDK regenerated if server routes or schemas changed (`./script/generate.ts`)
- [ ] `bun run localization:check` passes if product copy, accessibility text, locale-sensitive formatting, or shared UI copy changed
- [ ] Documentation, AGENTS, and `.synergy` help updated if developer workflow, quality tooling, commands, or contributor rules changed
- [ ] Material external sources are marked near the authoritative implementation and listed above, or the section says `None`
- [ ] No secrets, local auth files, unrelated cleanup, placeholder scripts, or redundant compatibility wrappers included
