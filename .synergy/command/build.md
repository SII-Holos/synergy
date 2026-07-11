Build the requested Synergy source target and report exact results. Interpret `$ARGUMENTS` as the target or additional requirement.

1. Inspect current changes and choose the smallest matching build:

```bash
./packages/synergy/script/build.ts --single
bun dev build app
bun dev build desktop
```

2. If server routes or OpenAPI-visible schemas changed, regenerate before the final build/check:

```bash
./script/generate.ts
```

3. Run the target's narrow tests or smoke check, then run `bun run quality:quick` unless the user requested only a diagnostic build.
4. Fix in-scope build failures at their root and rerun the failed command. Do not bypass hooks, discard unrelated changes, or restart the active Synergy instance.
5. Report the target, commands, generated files, pass/fail result, and any unrun platform-specific checks.

$ARGUMENTS
