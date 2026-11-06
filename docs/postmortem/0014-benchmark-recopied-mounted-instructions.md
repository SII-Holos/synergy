# Benchmark recopied mounted instructions

## Executive summary

原生 Codex 预检和 DeepSeek Harness 评分尝试各有一次 CI 执行在模型请求前失败。评测器先把指令写入宿主日志目录，又调用 Docker Compose 将其上传到已经绑定该目录的容器路径。失败发生在这次多余的复制操作；修复使用 Pier 声明的日志挂载能力，挂载环境直接读取已有文件，非挂载环境继续上传。

## Summary

同一 CI 作业的 Chat Completions 组合完成，Responses 组合的第一个模型预检完成，第二个模型预检在上传指令时收到 `docker compose cp` 非零退出。没有启动原生 CLI，也没有模型请求，失败预检和缺失执行、归档证据均被保留，后续评分没有继续派发。另一独立作业的 DeepSeek Harness 也在同一指令上传调用处失败，账本为零次请求；不是模型解题或协议转换失败。

## Timeline

- 真实原生矩阵触发预检失败，完整收集其他已完成的请求证据。
- 异常调用链定位到指令上传；核对 Pier 0.3.1 的默认日志绑定和 `capabilities.mounted` 合同，确认源文件和容器目标引用同一份宿主文件。
- 使用真实临时文件建立挂载与非挂载两种传输夹具，挂载场景在重复复制时稳定触发同文件错误。
- 改为仅在日志未挂载时上传，保留代理环境、指令原文和短期凭据传输。

## Root cause

适配器没有采用环境已经声明的日志挂载合同，为可直接读取的输入增加了一次无必要的 Docker 传输故障点。该合同与冻结的上游来源见 [Pier provenance](../../benchmark/third_party/pier/NOTICE)。

原 CI 只保留了 Compose 退出状态和调用位置，没有上传私有 Compose 日志，因此无法确认该次 Docker 内部的具体错误。独立的 38 次 Docker 同路径复制控制全部通过；不能将其描述成每次必现的 Docker 同文件错误。可以确认并修复的是适配器对重复复制的错误依赖；临时文件回归证明挂载环境无需支持再次复制到同一文件。

## Guardrails added

- [适配器](../../benchmark/src/synergy_bench/agent.py) 只向未挂载日志的环境上传指令；凭据仍从挂载目录之外的私有临时文件单独传入。
- [行为回归](../../benchmark/test/test_agent.py) 对挂载与非挂载环境、普通与代理网络交叉验证完整 Unicode 指令在原生入口可读。
- [真实原生矩阵](../../benchmark/test/test_matrix_docker.py) 继续通过实际容器、五种 CLI 和两种模型协议验证指令与工具往返，不因该次基础设施失败跳过组合。

## Lessons

环境声明的挂载能力决定文件是否已经可见；重复调用上传接口不会增加可靠性。故障定位应区分可证明的适配层依赖与尚未保留证据的底层错误，不能用本地通过的控制反推历史失败原因。
