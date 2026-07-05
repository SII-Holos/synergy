Build the Synergy project and regenerate the SDK.

Execute:

```bash
./packages/synergy/script/build.ts --single
```

If build succeeds, regenerate the SDK:

```bash
./script/generate.ts
```

Report build results and any errors. $ARGUMENTS

### Quality verification

After building, run quality checks to ensure no regressions:

```bash
bun run quality:quick
```

If the build or any quality check fails, fix the root cause and re-run.
