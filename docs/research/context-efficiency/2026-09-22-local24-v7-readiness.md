# Local-24 v7 readiness inventory

This records free infrastructure admission for the [prospective paired study](2026-09-22-local24-v6-protocol.md), before real-provider preflight and scoring. It is not evidence of model success.

The subsequent [terminal study report](2026-09-22-local24-v7-stopped-study.md) records a live preflight cleanup failure and all 48 formal cells remaining unstarted; this preparation inventory does not override that outcome.

The frozen schedule contains 24 task pairs and 48 formal cells. Plan digest: `a5b581efd3c086b0b3575a0c1539a0d47b0ac101436b0fbcdca4f8f379582191`. Evaluator Python digest: `b69016eb308334c4b6b3c7859a893cf6b15f5fbfc3ae018f1d703932a861f20d`; runtime digest: `377e08b5a52a29bcb735de49b8e618b3c928d2df6928756bb54ee3c8803886d1`. Solving and verification each use 10800 seconds.

All 24 native references passed with test-start evidence and verified file hashes. Twenty-two references reuse byte-identical task inputs, retaining their historical evaluator and deadline metadata. The two final dependency variants passed new native references. Forty-two historical product/tool checks were independently revalidated; twelve new checks exercised both products with two deterministic models on Cython, Stan and bandit. All 24 task images completed prewarming. No paid model request was sent before this inventory.

| Task                                                 | Task digest    | Reference tests observed | Verified product/tool checks |
| ---------------------------------------------------- | -------------- | -----------------------: | ---------------------------: |
| deepswe-1.1/bandit-incremental-cache-control         | `57591792df33` |                      363 |                            4 |
| deepswe-1.1/boa-hierarchical-evaluation-cancellation | `74755bc965bf` |                       24 |                            2 |
| deepswe-1.1/dasel-html-document-format               | `dca5f40de1b3` |                     1158 |                            2 |
| deepswe-1.1/drizzle-orm-window-function-builders     | `6ea74d4e12e2` |                      696 |                            2 |
| deepswe-1.1/fd-deterministic-multi-key-sorting       | `d7bc1a5bc961` |                      152 |                            2 |
| deepswe-1.1/katex-multicolumn-array-spans            | `c7a64e0c6b01` |                      693 |                            2 |
| deepswe-1.1/kcp-go-multiplexed-kcp-streams           | `c6234605fcf8` |                       42 |                            2 |
| deepswe-1.1/kgateway-consistent-hash-policy          | `36e4607ff066` |                      216 |                            2 |
| deepswe-1.1/mobly-grouped-test-barriers              | `d270b20f8d24` |                      887 |                            2 |
| deepswe-1.1/sqlfmt-create-table-ddl-formatting       | `9301cbecc65c` |                     1305 |                            2 |
| deepswe-1.1/superjson-error-stack-serialization      | `fb66b7fd7e83` |                      196 |                            2 |
| deepswe-1.1/valibot-recursive-schema-composition     | `34e54f239fc9` |                      219 |                            2 |
| terminal-bench-2.1/adaptive-rejection-sampler        | `cfebea283d9d` |                        9 |                            2 |
| local24-repro-v6/build-cython-ext                    | `b5048a2f73a7` |                       11 |                            4 |
| terminal-bench-2.1/compile-compcert                  | `b010e3868349` |                        3 |                            2 |
| terminal-bench-2.1/feal-linear-cryptanalysis         | `0ebabb63e217` |                        1 |                            2 |
| terminal-bench-2.1/financial-document-processor      | `686e13969275` |                        7 |                            2 |
| terminal-bench-2.1/large-scale-text-editing          | `3efcd0c61662` |                        5 |                            2 |
| terminal-bench-2.1/mailman                           | `85c8d4ff93d8` |                        3 |                            2 |
| terminal-bench-2.1/make-doom-for-mips                | `ccff8869f481` |                        3 |                            2 |
| local24-repro-v6/mcmc-sampling-stan                  | `6b5b598dbdde` |                        6 |                            4 |
| terminal-bench-2.1/openssl-selfsigned-cert           | `887b6437e4a3` |                        6 |                            2 |
| terminal-bench-2.1/path-tracing-reverse              | `01c46d7eb7ce` |                        3 |                            2 |
| terminal-bench-2.1/polyglot-c-py                     | `39f07cf87a13` |                        1 |                            2 |

The original dependency reference failures, the original bandit cleanup failure, and v5 final refusal remain unchanged. New controls are separate observations, not replacements. Cython and Stan keep their original instructions and verifier assertions and have explicit dependency variant identities. Test counts retain the evaluator’s maximum-observed-count semantics across overlapping native reports.

Real-provider admission will run 48 separately accounted tool preflights. A failed preflight or formal infrastructure/evidence audit stops subsequent dispatch. Native zero rewards continue. No failed or cancelled attempt is silently retried.

At preparation, branch CI run [35696063127](https://github.com/SII-Holos/synergy/actions/runs/35696063127) failed in the external DeepSeek CLI matrix because an npm dependency version was unavailable. That CLI is not a measured harness in this Synergy study. The failure remains a PR readiness blocker; it is not waived.
