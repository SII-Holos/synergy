# Postmortems

Failures, causes and guardrails.

## When to write one

Criteria:

- **Subtle** — the mechanism requires careful investigation.
- **Systemic** — a gap in tests, tooling, or conventions let the bug escape.
- **Costly to rediscover** — rediscovery would repeat substantial debugging.

Otherwise, add a tested fix.

## Placement

- Bugs and underlying process failures belong here.
- Decisions, alternatives and rationale belong in `docs/decisions/`.

## Format

Use the next `NNNN-kebab-case-title.md`. Sections:

- **Executive summary** — one paragraph: what broke, its cause, why it escaped, and the durable lesson.
- **Summary** — details of the failure.
- **Timeline** — what was observed and when.
- **Root cause** — the mechanism and missing safeguards.
- **Guardrails added** — linked fixes: tests, doc updates, gate changes.
- **Lessons** — the durable takeaways.

## Index

- [0058: Markdown settlement](0058-markdown-terminal-estimates-lost-reading.md)

- [0056: PostgreSQL cleanup](0056-postgres-node-cleanup-repeated-candidates.md)
- [0055: Workspace tool discovery](0055-discovery-omitted-workspace-selection.md)
- [0054: Logical file paths](0054-logical-workspace-path-classification.md)
- [0053: Incomplete Environment release](0053-absent-compute-lost-release-intent.md)
- [0049: Runtime startup readiness and progress](0049-storage-recovery-startup-progress-gap.md)
- [0048: Process stability](0048-process-layout-and-arrival-ownership.md)
- [0046: Structured output retained tool intent](0046-structured-output-retained-tool-intent.md)

- [0045: PostgreSQL startup DDL blocked writers](0045-postgres-startup-ddl-blocked-writers.md)

- [0042: Compaction completion](0042-process-event-ownership-and-compaction-completion.md)
- [0041: Lost completion signal](0041-cortex-progress-fixture-lost-release.md)
- [0040: Vite ports](0040-vite-fixtures-shared-default-ports.md)
- [0039: Process activation deadlock](0039-paused-output-blocked-process-activation.md)
- [0038: Session latency](0038-session-interactions-amplified-global-work.md)
- [0035: Titlebar controls](0035-native-titlebar-swallowed-controls.md)
- [0043: Historical data blocked startup](0043-historical-data-blocked-startup.md)
- [0036: Directory replacement blocked history](0036-directory-replacement-blocked-history.md)

| Number | Title                                                                      | Status      | Date       |
| ------ | -------------------------------------------------------------------------- | ----------- | ---------- |
| 0001   | Coverage-mode test run wrote fixtures into the real Synergy home           | implemented | 2026-08-18 |
| 0002   | ToolScheduler singleton leaked across CI shard-process tests               | implemented | 2026-08-20 |
| 0003   | Leaked module-level fetch stub failed the arXiv suite on CI                | implemented | 2026-08-27 |
| 0004   | Scope-scoped theme registry flipped the skin on session switches           | implemented | 2026-08-30 |
| 0005   | Linux inotify exhaustion stormed the file watcher and degraded the process | implemented | 2026-09-03 |
| 0006   | Sequential lock-worker spawns consumed the CI test budget                  | implemented | 2026-09-05 |
| 0007   | Hidden tool renderers retained highlight state                             | implemented | 2026-09-07 |
| 0008   | Transition cleanup retained disposed frontend pages                        | implemented | 2026-09-07 |

| 0009 | Local benchmark cancellation lost export evidence | implemented | 2026-09-10 |
| 0010 | Global event subscription loss left the UI connected but stale | implemented | 2026-09-12 |
| 0011 | Watcher static C++ runtime crashed subsequent ONNX loading | implemented | 2026-09-12 |
| 0012 | Preparation deadline truncated native benchmark execution | implemented | 2026-09-14 |
| 0013 | Short native probes missed OpenCode runtime stalls under Rosetta | mitigated | 2026-09-14 |
| 0014 | Benchmark recopied instructions into their existing bind mount | implemented | 2026-09-14 |

| 0015 | Streaming checkpoint ordering and repair | implemented | 2026-09-18 |

| 0016 | Interactive reads scanned historical state | implemented | 2026-09-18 |

| 0017 | Unmapped certificate failure terminated a long child task | implemented | 2026-09-19 |
| 0018 | Host suspend pinned a session in recovering | implemented | 2026-09-19 |

| 0019 | Retention maintenance stalled the live writer | implemented | 2026-09-19 |

| 0020 | Managed startup maintenance outgrew Desktop progress | implemented | 2026-09-20 |

| 0021 | A healthy SQLite worker was declared dead | implemented | 2026-09-20 |
| 0022 | Benchmark admission and evidence defects | implemented | 2026-09-22 |

| 0022 | Optional format rewrite blocked startup | implemented | 2026-09-21 |

| 0023 | Historical preparation blocked its own evidence writes | implemented | 2026-09-21 |

| 0024 | Provider fetch wrappers lost request inputs | implemented | 2026-09-22 |

| 0025 | Lazy Session upgrade emptied navigation | implemented | 2026-09-22 |

| 0026 | [A started runtime stranded saved input](0026-started-runtime-stranded-saved-input.md) | implemented | 2026-09-22 |

| 0027 | [Archive 的运行时收尾延迟被计入长会话清理](0027-archive-work-delayed-rollout-cleanup.md) | implemented | 2026-09-24 |

| 0028 | [Unverified Workspace directory access](0028-unverified-workspace-directory-access.md) | implemented | 2026-09-23 |

| 0029 | [Recreated GitHub checkout generation](0029-recreated-github-checkout-generation.md) | implemented | 2026-09-23 |

| 0030 | [Review opaque resource keys](0030-review-opaque-resource-keys.md) | implemented | 2026-09-24 |

| 0031 | [Concurrent Worktree retirement deadlock](0031-concurrent-worktree-retirement-deadlock.md) | implemented | 2026-09-23 |

| 0023 | Benchmark exhausted Docker network addresses | implemented | 2026-09-23 |
| 0024 | Benchmark observer imposed a stream idle timeout | implemented | 2026-09-23 |
| 0025 | Benchmark verifier dependencies and missing results | implemented | 2026-09-23 |

| 0032 | [Workspace-free attachment preparation](0032-workspace-free-attachment-preparation.md) | implemented | 2026-09-28 |

| 0033 | [Completed terminal blocked Runtime shutdown](0033-completed-terminal-blocked-runtime-shutdown.md) | implemented | 2026-09-28 |

| 0034 | [Composer uploads suppressed attachment content](0034-composer-upload-suppressed-content.md) | implemented | 2026-09-28 |

- [0037: Mount identity](0037-mount-number-invalidated-directory.md)

## History rules

Preserve history; append corrections.
