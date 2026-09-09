# Synergy 本地评测

本目录维护本地研究评测，产品执行与计量复用 Synergy runtime。Python 负责任务、配对与结果；TypeScript 负责选择运行组合。原题、被测源码和评测工程分别记录身份。

使用 `uv run --project benchmark pytest benchmark/test` 运行 Python 行为测试。任务结果、下载数据和源码快照存放在 Git 忽略的 `.artifacts/benchmark`，不进入产品发布。
