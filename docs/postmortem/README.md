# Postmortems

## Criteria

- **Subtle**.
- **Systemic** — missed safeguards.
- **Costly**.

## Format

`NNNN-kebab-case-title.md`:

- **Executive summary** — failure, cause, lesson.
- **Summary** — details.
- **Timeline** — observations.
- **Root cause** — missing safeguards.
- **Guardrails** — tests, docs, gates.
- **Lessons** — takeaways.

## Index

- [0091](0091-emitted-error-predicate-lost-narrowing.md)

- [0090](0090-provider-recovery-stream-lifetime.md)

- [0089](0089-session-observation-hydrated-unrequested-history.md)

- [0088](0088-storage-admission-misclassified-as-session-preparation.md)

- [0087](0087-browser-view-completed-without-presentation.md)

- [0086](0086-loop-failure-state-divergence.md)

- [0085](0085-cross-scope-status-snapshot-resurrected-busy.md)

- [0084](0084-replaced-directory-checkpoint-blocked-rebind.md)

- [0083](0083-blueprint-blockers-could-not-pause.md)

- [0082](0082-performance-evidence-and-failure-retention.md)

- [0081](0081-browser-navigation-timeouts.md)

- [0080](0080-virtual-process-disclosure-demand.md)

- [0079](0079-remount-and-confirmed-selection.md)

- [0078](0078-cold-navigation-migration-admission.md)

- [0074: Agenda origin](0074-agenda-home-origin-blocked-session-creation.md)

- [0072: Watcher concurrency](0072-native-watcher-exception-concurrency.md)

- [0071: Cold hydration](0071-cold-conversation-hydration-motion.md)

- [0070: Rebound](0070-new-row-following-rebound.md)

- [0069: History anchors](0069-history-pagination-reading-anchor.md)

- [0068: Measurements](0068-conversation-measurement-identity.md)

- [0067: Isolated containment](0067-isolated-runtime-containment-gaps.md)

- [0066: Completion settlement](0066-completion-waited-for-file-settlement.md)

- [0065: Session navigation](0065-session-navigation-flashed-introduction.md)

- [0064: History latency](0064-history-pages-scanned-authoritative-storage.md)
- [0064: Attachment identity](0064-visual-card-attachment-identity.md)

- [0063: Startup replay](0063-history-replay-blocked-startup.md)

- [0062: Historical project bindings](0062-project-migration-required-live-directory-identity.md)
- [0061: Concurrent Workspace admission](0061-concurrent-workspace-admission.md)
- [0061: Usage recovery](0061-streamed-usage-recovery.md)

- [0059: Disclosure](0059-cold-process-disclosure-jank.md)

- [0058: Markdown settlement](0058-markdown-terminal-estimates-lost-reading.md)
- [0057: Conversation lifetime](0057-conversation-rendering-lifetime-and-scope-retention.md)
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

Only append corrections.
