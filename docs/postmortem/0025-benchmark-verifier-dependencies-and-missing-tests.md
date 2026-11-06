# Benchmark verifier dependencies and missing test results

## Executive summary

The GLM study included native zero rewards caused by verifier dependency setup failures. Ordinary task containers did not receive the host dependency proxy, while one intentionally offline verifier lacked a package version introduced by the model's patch. Synthetic failed CTRF rows then made that latter attempt appear to have started tests. Container connectivity, patch-induced dependency changes and positive test execution evidence need independent checks.

## Summary

Several Terminal-Bench verifiers failed to download their test runner or interpreter. The native tasks allowed internet access, but host proxy configuration was not propagated to their commands. The baseline Boa patch separately changed `husky-rs` from 0.3.2 to 0.3.3. Its offline verifier image only contained the original package, so Cargo failed dependency resolution before either suite ran. The candidate retained the original dependency and completed its tests.

DeepSWE preserves its native zero reward when required results are absent and creates a failed CTRF row for each missing result. Boa therefore had 24 failed rows with explicit missing-result messages and no executed tests. Treating these rows as test starts was an evaluator reporting defect. Describing Boa as merely random DNS failure also omitted the model's lockfile change and the native offline policy.

## Timeline

- 2026-09-23: the paired study retained native scores and manually identified setup failures; its published data kept all original attempts and costs.
- Raw Boa suite logs and CTRF messages showed that the 24 rows were placeholders. The frozen evaluator remained unchanged while the report distinguished this limitation.
- Subsequent patch inspection identified the dependency version change and the original offline verifier policy. A disposable image inspection confirmed that only version 0.3.2 was cached.
- Free container tests exercised dependency proxy forwarding and cleanup. The native financial-document image completed its ordinary apt/curl setup and downloaded the uv installer, a Rust crate and the PyPI reporter index through the declared proxy.
- A separate [dependency-only Boa regrade](../research/context-efficiency/2026-09-23-boa-dependency-regrade.md) used the exact retained patch and the public crate verified against its lockfile checksum. All 24 native tests ran: 22 passed and two failed, with reward still zero and no new model calls. The original reward, network policy and tests remain intact.

## Root cause

Host connectivity tests did not cover the native container command environment. A loopback proxy address is local to the host, so simply copying it into Docker would still fail. The evaluator needs a container-reachable route only for tasks that already permit internet access.

The test-start parser counted all passed or failed CTRF rows. It did not exclude the native verifier's explicit missing-result messages. Small successful fixtures exercised ordinary rows, but not a complete synthetic failure catalog after a dependency error. DNS-looking output was also interpreted without first checking whether a patch had changed dependencies in a deliberately offline task.

## Guardrails added

- [Dependency routing](../../benchmark/src/synergy_bench/dependency_proxy.py) is explicit, limited to internet-enabled native environments and frozen for resume and pairing. [Socket tests](../../benchmark/test/test_dependency_proxy.py) and a [real Docker fixture](../../benchmark/test/test_dependency_proxy_docker.py) verify forwarding and owned-resource cleanup.
- [Evidence collection](../../benchmark/src/synergy_bench/evidence.py) excludes explicit missing-result rows from positive counts. [Regressions](../../benchmark/test/test_evidence.py) cover all-missing and mixed executed/missing reports without rewriting reward.
- The [benchmark Skill](../../.synergy/skill/develop-benchmark/SKILL.md) requires inspection of raw test output, retained dependency changes and actual container routing, and describes separate regrading without another model call.
- The [decision](../decisions/implemented/bug-fix/2026-09-23-benchmark-dependency-routing-and-test-evidence.md) records rejected implicit proxy and full-matrix rerun alternatives.

## Lessons

A dependency error is an observed symptom whose cause may include both the environment and the model's patch. A zero reward or a full failed-test catalog does not establish that the test suite ran. Re-evaluation must retain the original observation and declare any changed dependency condition.
