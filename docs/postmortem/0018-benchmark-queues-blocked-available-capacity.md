# Benchmark queues blocked available capacity

## Executive summary

本地评测长期存活但缺乏有效进展：一个原生任务停滞并保留完整内存配额，固定预热批次和续跑终态检查又使可运行任务排在资源申请之后。资源池自身的小任务回填测试通过，调用方却没有把这些任务交给资源池。监控不能只确认进程存活，必须核对有用进展与排队原因。

## Summary

原生 OpenCode 在全部已知工具结束后停止产生模型请求和事件，采样 CPU 无变化；内部运行时根因尚未确定。解题进程实际占用远低于容器内存上限，调度租约却一直按上限预留。预热某一批中的大任务因剩余内存不足而等待，该批后面的轻量任务没有机会进入队列。恢复流程中的已完成大任务也需要先获得资源才能被跳过。

## Timeline

- 2026-09-16：核对原生事件、已结束请求和进程采样，确认停滞观测，保留内部原因未知的结论。
- 2026-09-16：复现固定批次阻塞与终态跳过之前申请资源的两个问题，新增回归测试后修复。
- 2026-09-16：经用户要求提高实际吞吐，保留停滞尝试并正常取消归档，单独声明新的调度条件。

## Root cause

[资源池](../../benchmark/src/synergy_bench/resources.py) 可以回填已排队的小任务，但 [prewarm 调用方](../../benchmark/src/synergy_bench/maintenance.py) 每批等待全部任务结束才提交下一批。原有测试覆盖资源池本身，没有覆盖调用方在另一个进程持有部分容量时的行为。[续跑](../../benchmark/src/synergy_bench/runner.py) 把终态判断放在资源保留块内部，令无需执行的任务同样等待容量。长解题期限用于保护正常计算，却也延长了未及时处理的原生停滞；不能据此推断服务商并发受限。

## Guardrails added

- [预热行为测试](../../benchmark/test/test_maintenance.py) 在独立调度器占用资源时验证后续小任务能够完成。
- [续跑行为测试](../../benchmark/test/test_runner.py) 验证 completed 和可恢复终态在申请资源之前被跳过。
- [资源测试](../../benchmark/test/test_resources.py) 核对显式预留比例、原始上限和 Docker 压力准入；[报告测试](../../benchmark/test/test_report.py) 拒绝跨预留策略直接配对。
- [开发流程](../../.synergy/skill/develop-benchmark/SKILL.md) 要求区分存活、实际进展、预留和实测占用；[调度决策](../decisions/implemented/bug-fix/2026-09-16-benchmark-resource-queue-progress.md) 保留默认完整预留和显式超额订阅的取舍。

## Lessons

局部资源调度正确不等于整个调用链能够持续推进。原生执行停滞、队列阻塞和内存配额是不同问题，应分别保留证据、处理和验证。降低预留改善吞吐，也引入峰值重叠风险，必须作为新的实验条件记录。
