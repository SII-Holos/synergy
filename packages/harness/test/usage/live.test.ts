import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { UsageQuery } from "../../src/usage/query"

test.skipIf(process.env.SYNERGY_USAGE_LIVE_MODEL !== "1")(
  "real streaming provider reports are retained in an isolated ledger",
  async () => {
    const deepseek = process.env.SYNERGY_USAGE_LIVE_PROVIDER === "deepseek"
    const credential =
      process.env.SYNERGY_USAGE_LIVE_API_KEY ??
      (deepseek ? process.env.DEEPSEEK_API_KEY : process.env.ZHIPU_CODING_PLAN_API_KEY)
    if (!credential) throw new Error("The live usage test requires its fixture credential")
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const owner = { kind: "operation" as const, scopeID: "home", operationID: crypto.randomUUID() }
      const request = {
        model: deepseek ? "deepseek-chat" : "glm-5.3-flash",
        messages: [{ role: "user", content: "Reply with READY only." }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 256,
        ...(deepseek ? {} : { thinking: { type: "enabled" }, reasoning_effort: "low" }),
      }
      await RolloutCall.execute(
        {
          owner,
          runID: "live",
          purpose: "model.validation",
          kind: "chat",
          request,
          model: {
            providerID: deepseek ? "deepseek" : "zhipuai-coding-plan",
            modelID: request.model,
            sdk: "@ai-sdk/openai-compatible",
            pricing: null,
            billingMode: deepseek ? "api" : "subscription",
          },
        },
        async () => {
          const response = await RolloutTransport.sdkFetch(
            deepseek
              ? "https://api.deepseek.com/chat/completions"
              : "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
            {
              method: "POST",
              headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
              body: JSON.stringify(request),
              signal: AbortSignal.timeout(90000),
            },
          )
          const body = await response.text()
          if (!response.ok) {
            const error = JSON.parse(body)?.error
            throw new Error(
              `Live provider returned HTTP ${response.status}: ${String(error?.message ?? error?.code ?? "unknown")
                .replaceAll(credential, "[redacted]")
                .slice(0, 300)}`,
            )
          }
          return { value: undefined, response: { status: response.status } }
        },
      )
      const summary = await UsageQuery.summary({ scopeID: "home" })
      expect(summary.accounting.attempts).toBe(1)
      expect(summary.accounting.tokens.input.total).toBeGreaterThan(0)
      expect(summary.accounting.tokens.output.total).toBeGreaterThan(0)
      expect(summary.accounting.apiEstimate.known).toBe(0)
      expect((deepseek ? summary.accounting.apiEstimate : summary.accounting.subscriptionEquivalent).unknown).toBe(1)
      expect(summary.latestRequest?.timing?.ttftMs).toBeGreaterThan(0)
      expect(summary.latestRequest?.timing?.requestMs).toBeGreaterThan(0)
      expect(JSON.stringify(await UsageQuery.records()).includes(credential)).toBe(false)
      console.info(
        JSON.stringify({
          liveUsage: {
            tokens: summary.accounting.tokens,
            cache: summary.cache,
            latency: summary.latency,
            rates: summary.rates,
            pricing: "unavailable; estimate remains unknown",
          },
        }),
      )
    })
  },
  120000,
)
