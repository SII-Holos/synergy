# Decision Record: Versioned benchmark task dependencies

Status: implemented

## Problem

A pinned task repository can still install changing dependencies while solving or grading. A reference failure then makes model scores ambiguous: the requested implementation and the environment can fail independently. A prebuilt task image also takes precedence over a changed Dockerfile, and native shell environments can filter dependency-related environment variables.

## Decision

The [derived task payloads](../../../../benchmark/tasks/README.md) retain their upstream license, source revision, original digests, unchanged-file hashes and explicit change lists. They use separate task identities and never overwrite the original suite or experiment evidence. Original instructions, assertions and resources are preserved; the evaluator supplies its fixed three-hour execution budget.

Each dependency layer starts from its original public task image pinned by digest and is selected through the task's Dockerfile. Cython distribution artifacts have fixed public URLs and SHA-256 hashes; building planarity and subsequent pip invocations use those local artifacts with the package index disabled. The resulting wheel manifest records installed candidates and hashes, and a system pip configuration exposes constraints and cache locations to native tool subprocesses. Stan's image adds the build tool required by its reference dependency while the isolated reference preserves selected package versions. Its verifier interpreter and pytest dependencies are prepared before execution and selected from the uv cache offline, preserving the original verifier script.

These layers provide dependencies rather than task solutions. They do not patch pyknotid, install RStan or generate model outputs. Native reference controls and both product tool paths must validate the actual resulting images before a study can use them. Environment repair results and original upstream scores remain separate populations.

## Alternatives considered

**Patch the original task in place.** This would make its content identifier and historical scores misleading.

**Repair only the oracle script.** This would leave model environments exposed to the dependency failure and would not establish task readiness.

**Rely on package index resolution during every solve.** Repeated resolution can change selected versions or fail before a valid distribution is found. Content-addressed artifacts move this failure into visible, unpaid preparation.

## Consequences

The derived tasks are local evaluation variants rather than unmodified official benchmark tasks. Maintaining their dependency manifests is an explicit versioned change. Artifact availability can still fail during preparation, and network access remains part of the original tasks. The frozen image receipts and native evidence are required alongside the source lock for reproduction.
