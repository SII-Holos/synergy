# 原生判题修正补丁

这些补丁是显式修正实验的输入，不由 runner 自动应用。默认 [local-24](../suites/local-24.json) 继续使用锁定的原始题目与原生 verifier。修正后的题目必须使用新的内容摘要和实验身份，不能覆盖冻结输入或改写既有 reward；应用和验证流程见 [develop-benchmark](../../.synergy/skill/develop-benchmark/SKILL.md)。

## DOOM 输出新鲜度

[补丁](terminal-bench-2.1/make-doom-for-mips-output-freshness.patch) 修正 `make-doom-for-mips` 的启动检查：启动新的 VM 前清除旧帧，并等待该进程的初始化输出及帧文件，保留原有 30 秒期限、初始化字符串和图像相似度阈值。旧帧不再使 verifier 在新 VM 初始化前结束等待。

| 输入             | 锁定值                                                             |
| ---------------- | ------------------------------------------------------------------ |
| 来源             | `harbor-framework/terminal-bench-2-1`                              |
| revision         | `7131e4375048a0e408a8fb404b5f499d726b695b`                         |
| 原文件           | `tasks/make-doom-for-mips/tests/test_outputs.py`                   |
| 原文件 SHA-256   | `f1748ff20bfd670af1e1cb935647503eb176a4a14dd15f20935264ad7e4a98f6` |
| 修正文件 SHA-256 | `b422d37d7b748586b0e13d1a8de702303975c876ee1f52272551aa04896095ca` |

补丁只改变等待条件，不改变模型输出、参考图像或成功断言。上游来源、revision 与许可入口由 [local-24 清单](../suites/local-24.json) 的 `terminal-bench-2.1` source 记录。诊断与恢复的证据边界见 [复盘](../../docs/postmortem/0016-stale-frame-invalidated-doom-verifier.md)，保留显式修正输入的理由见 [决定](../../docs/decisions/implemented/testing/2026-09-15-explicit-benchmark-verifier-corrections.md)。
