# Decision Record: 无法定因的网络失败按受限预算重试并保留端点证据

Status: implemented

## Problem

Bun 自带的 BoringSSL 在无法把 TLS 校验失败映射成原因码时抛出兜底字符串 `unknown certificate verification error`，错误对象没有 `code`、没有 `cause`。共享分类器当时只按已知错误码和既有证书措辞正则判定，不含该措辞，因此返回 `undefined`。供应商判定随后返回 `undefined`，`MessageV2.fromError` 落到 `UnknownError`，会话重试准入只白名单放行 worker 重启，最终错误按终止处理。

结果是一次可恢复的环境抖动杀死了长任务：一个 Cortex 子任务在连续 74 次成功模型调用之后，因第 75 次请求的响应只有 110 字节且被标记为 `partial` 而终止，8.2 分钟调研没有任何交付。同一台机器在 34 分钟后于父会话再次出现同一字符串和同样的 110 字节响应特征，间隔 6 秒内的相同体积请求有成功有失败，说明这是偶发且自愈的链路抖动，而不是持续配置错误。

旧策略的前提是「证书失败确定性复现，重试只是白烧额度」。该前提对带原因码的失败成立，对无法定因的失败不成立。缺少「已知码」与「未知原因」的区分，导致两种语义相反的失败走了同一条终止路径。

## Decision

[共享分类器](../../../../packages/util/src/network-error.ts) 新增第四种类别 `indeterminate`，与既有 `transient`、`permanent`、`aborted` 并列。判定顺序保持既有次序，并在 `permanent` 与 `transient` 之间插入：当节点消息同时匹配证书与校验措辞、且该节点没有产出任何码级判定时，返回 `{ kind: "indeterminate", category: "tls-verification" }`。`category` 是新增的判别字段，使调用方能区分具体情形而不是复用一个笼统的未知类别。带原因码的证书失败仍由既有 `permanent` 分支处理，`undefined` 仍表示「未识别」，两者语义不变。合并规则保持 `aborted > permanent` 优先；`indeterminate` 与 `transient` 同档，因此不会覆盖 `permanent`，但可以穿过通用的包装错误浮出。

[供应商判定](../../../../packages/harness/src/provider/retry.ts) 把 `indeterminate` 与 `transient` 一并纳入准入。分类修正之后，该错误会命中 `fromError` 的 `Error && providerRetryable !== undefined` 分支，持久化为结构化 `APIError`（`isRetryable: true`）而不是 `UnknownError`。

[会话重试](../../../../packages/harness/src/session/retry.ts) 的 `retryable()` 由返回 `string | undefined` 改为返回 `{ message, maxAttempts } | undefined`，让事实与预算各自归位：分类器只回答事实，预算仍由调用方持有。`category === "tls-verification"` 使用两额外次尝试与五秒退避上限，其余情形保持十次与三十秒。未知错误分支增加字符串兜底，仅凭文本无法还原对象时按同一受限预算处理。`AgentCall` 继续只判断 `!== undefined`，其预算仍由调用方 `input.retries` 决定，既有分工不变。

[网页抓取](../../../../packages/runtime-local/src/tools/webfetch.ts) 在自身既有的三次尝试与总截止时间内接纳该类别。

[端到端证据](../../../../packages/harness/src/session/message-v2.ts) 在错误元数据中新增 `networkKind`、`category` 与 `endpointHost`。端点主机名由控制面从既有连接身份来源派生（与 `providerRetryKey` 同源的 `options.baseURL ?? model.api?.url`，取其 host），因此不需要扩展 worker 错误帧，也不改变协议版本。只记录 host，path 与 query 不进入持久化元数据。

[环境诊断](../../../../packages/harness/src/provider/endpoint-diagnostics.ts) 在 `synergy doctor` 中报告 provider 端点路由与 TLS 校验结果：解析地址落在 `198.18.0.0/15` 或 `240.0.0.0/4`、存在半默认路由或默认路由挂在 TUN 设备时告警；TLS 校验失败判 fail。解析器与连接器可注入以便测试，探测受严格超时约束并在离线时降级为 warn。

## Alternatives considered

**只补分类器措辞，把无法定因的失败归为 `transient`。** 改动最小，但会让这类失败取得完整十次预算与三十秒级退避，超出一个未知原因应得的额度；遥测还会把它记成已知瞬时原因，使「证书类失败按策略终止」这一长期不变量失去可审计性。

**把无法定因的失败并入 `permanent`，只改进可观测性。** 保留了单次抖动杀死长任务的行为，与本轮目标（更 solid 更鲁棒）直接冲突。

**放宽 TLS 校验以绕过拦截。** 会让所有 HTTPS 流量对中间人无条件可信，把可用性问题换成安全问题。实测证据还显示拦截发生在 DNS 与路由层、TLS 本身是真实端到端（端点证书由公共 CA 签发且系统校验通过），放宽校验并不能消除抖动。

**扩展 worker 错误帧以携带原始 `path` 或 `url` 作为证据。** 需要提升协议版本并改动进程边界契约，且会把可能内嵌凭据的完整 URL 带进持久化错误——外部已有同类泄漏先例。控制面本已持有权威连接身份，从那里派生 host 收益相同而风险更低。

**同时在浏览器端放宽重试。** 运行时、传输与失败模式都不同，且未被该故障涉及；放宽只会扩大风险与测试面。

**为长任务增加结构性保命（有界续跑、部分成果留存、修改 Cortex 终态）。** 会改动 Cortex 终态语义与父会话交付契约，超出本轮范围；受限重试已覆盖该故障形态。

## Consequences

无法定因的证书校验抖动不再必然终止正在运行的长任务，带原因码的确定性配置错误仍然快速失败，两类语义相反的失败获得了各自的路径。失败错误现在能同时回答「哪一类网络失败」与「打到哪个端点」，且在代理或 TUN 拦截环境中 `synergy doctor` 会给出可执行的恢复指引。

代价是三方面。第一，真正的 CA 配置错误会多消耗两次模型调用才会终止，换来的是对抖动类故障的自动恢复。第二，`SessionRetry.retryable()` 的返回类型是跨模块契约变更，所有消费点必须同步，`maxAttempts` 取代了原先隐含的全局常量。第三，新增的 `category` 字段是将来扩展其他无法定因情形的挂载点，需要保持判别值稳定。

仍未覆盖的范围：MCP、插件与其他写入路径也存在同名字符串的可能性，本轮只让模型调用与网页抓取接纳该类别，其余维持既有策略。无法定因的失败不做整段任务重试，也不做成果留存；重试预算耗尽后任务仍按现状终止。
