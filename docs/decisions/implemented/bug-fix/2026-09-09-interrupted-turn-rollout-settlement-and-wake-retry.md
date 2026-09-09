# Decision Record: Interrupted turns settle rollout orphans and session wake retries

Status: implemented

## Problem

用户中止一轮对话后，rollout ledger 里可能残留状态仍为 `running` 的 call/tool/process 记录：中止路径跳过了它们的完成写入。此后该 session 的每次消息发送都会成功入队持久收件箱，但驱动链 `SessionDrive.request` → `scheduleWake` → `wake` 在 `RolloutLifecycle.reconcile` → `finishRun` 处被 `Rollout still has active calls` 之类守卫抛错。唤醒链是 fire-and-forget 的，单次抛错后没有任何重试，消息永久停留在收件箱——UI 表现为"新建 session 发消息有概率卡住"，只能靠重启进程由 startup recovery 兜底。生产日志在半天内记录了 33 次这样的 `async session wake failed`，集中在少数几个被中止过的 session 上反复复现。

## Decision

`RolloutLifecycle.reconcile` 在确认 run 已静默（无 running segment）后，把残留 `running` 的 call/tool/process 记录结算为 `interrupted`（`settleOrphanedRecords`），再走既有的 `finishRun` 定案；结算复用 recovery 的既有语义，ledger finishers 幂等，重复 reconcile 安全。对"活跃 run"的守卫原样保留：只要有 segment 仍在 running，reconcile 照旧返回未定案的 run。`SessionManager.wake` 把 `repairAfterAbort` 降级为 best-effort（失败记 warn 后继续 loop），`scheduleWake` 改为带上限的退避重试链（250ms/1s/2s/4s/8s），重试期间同 session 的重复唤醒请求合并，重试耗尽才放弃并打含 `retriesExhausted` 的 error。重试延迟表通过导出的 `WAKE_RETRY_DELAYS_MS` 数组暴露给测试。

## Alternatives considered

**在 `finishRun` 内部静默结转孤儿记录。** 不采用：ledger 是证据层，它对活跃工作抛错的守卫同时被既有测试与 recording-failure 语义依赖；把"运行时认为 run 已结束"的策略塞进证据层会让活跃 run 与静默 run 的界线在两个方向上都变模糊。结算决策属于生命周期层（reconcile 已经拥有"run 何时算结束"的全部判定上下文）。

**给收件箱入队改为同步等待处理完成。** 不采用：`prompt_async` 的语义就是立即返回，同步等待会把 HTTP 请求生命周期与一轮模型执行耦合，超时与断连语义都要重新发明，且不能修复消息队列里已存在的卡死项。

**唤醒失败后无限重试。** 不采用：持续性故障（存储损坏、永久 provider 错误）会变成无限重试风暴；有界重试加显式 `retriesExhausted` 日志让放弃可见、可告警，startup recovery 仍是最终兜底。

## Consequences

被中止的 turn 留下的孤儿证据以 `interrupted` 状态保留在 ledger 中（与进程重启 recovery 的结转语义一致），不再把 session 楔死；用户重发消息会由重试链驱动到成功，无需重启。代价是 `reconcile` 每次对 run 的 call/tool/process 做三次枚举（原本只读 segments），对正常完成的 run 这些列表非空但全部已终结，结转循环零写入。唤醒合并意味着同一 session 的第二个入队请求不再触发额外唤醒链，依赖"每次 deliver 必触发一次 wake"的调用方不受影响——合并只发生在既有链尚未收敛时，链结束时收件箱仍有可运行项的情况由 release 路径的 `requestNextWork` 再次驱动。

Live background process writers remain authoritative after their tool and segment finish: reconciliation interrupts only process records without an active rollout writer, preserving later output and terminal exit evidence. Wake coalescing retains requests arriving during a running attempt and schedules a fresh attempt after success, so the release path cannot lose queued continuation work. Regression tests cover both boundaries.
