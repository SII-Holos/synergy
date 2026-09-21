# Boyue 编码观察对照验收

本实验与[官方 DeepSeek 小样本](2026-09-21-coding-observations-pilot.md)及[ARM 环境的 local-24 尝试](2026-09-21-local24-tool-efficiency.md)分开保留。服务商、模型和执行平台改变，历史 token、耗时和 reward 不进入本次配对。

## 预先固定的协议

基线为 `0e9973606a61793f414a54b994d18fe1b50dfd26`。候选使用修复后提交；两侧由同一个冻结 evaluator 准备，准确源码、配方和 evaluator 身份保存在实验 plan 与 receipt。正式派发后不改写输入或续跑到其他 evaluator。

两侧使用原生 Linux amd64、synergy-max、full runtime、`bun_jit: true`、并发 1、repeat 1、调度 seed 20260921 和 `timeout_seconds: native`。模型为 Boyue `bailian/deepseek-v4.1-flash`，Chat Completions，`enable_thinking: false`，不声明 reasoning tier，temperature 1、context 1000000、max output 8192、developer role disabled。主代理、辅助及子代理使用同一 profile。端点、凭据与直连设置仅在私有配置中保存。

小样本按[公开预设](../../../benchmark/configs/coding-observations-boyue.yaml)选择 dasel、superjson 和 large-scale-text-editing，每题两侧各一次，共六次正式执行。另用[委派夹具](../../../benchmark/test/fixtures/delegated-review/instruction.md)各执行一次；姓名规范化、Unicode 空白、非 BMP 字母、emoji 的校验在运行前固定。要求恰好一次 maintainability-reviewer 审阅同一工作目录的未提交修改，单列原生功能 reward 与委派次数，不能用其中一项替代另一项。

扩样前要求：基线通过的题候选也通过，候选至少通过一道原题，委派回归通过，执行、原生判题、归档与用量核对完整。小样本 token 或耗时上升单独报告，不阻止扩样。通过后另建完整 local-24 实验，每题每侧一次，共 48 次；筛查结果不进入该实验评分。

## 执行与证据要求

付费派发前完成两种确定性模型、两种协议的真实 Docker/CLI 验证和至少 120 轮原生读写负载。独立 oracle 检查原题，真实 doctor 检查受限网络、工具往返、关闭思考的实际请求以及完整 usage；基础设施失败阻止后续派发。

首次模型执行用于预定评分，不自动重抽样。原生失败、预检、取消及修复后新实验的费用均保留；未知 usage 不填零。输入包含缓存，缓存字段只作分解，不重复相加。没有版本化价格来源不换算货币。

逐题报告 reward、实际判题启动、失败阶段、主代理及全部辅助调用、输入/输出/缓存 token、墙钟和计量覆盖。工具反馈字节只作解释指标。全量单次重复提供描述性配对，不宣称统计显著；确认由候选引起的质量回归阻止 PR 就绪。

## 验收结果

实验尚未派发；本节在冻结输入后的实际验证结束时补充结果。准备成功不算模型或任务通过。
