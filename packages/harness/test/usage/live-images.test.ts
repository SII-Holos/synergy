import { expect, test } from "bun:test"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { UsageQuery } from "../../src/usage/query"
import { pngImage } from "../support/image"
import { testRuntime } from "../support/runtime"

// Provider contract: https://api-docs.deepseek.com/guides/vision/
const cases = [
  { name: "single image streaming", count: 1, size: 16, stream: true },
  { name: "multiple images JSON", count: 2, size: 16, stream: false },
  { name: "large image streaming", count: 1, size: 320, stream: true },
] as const

for (const item of cases) {
  test.skipIf(process.env.SYNERGY_USAGE_LIVE_IMAGES !== "1")(
    `real vision usage: ${item.name}`,
    async () => {
      const credential = process.env.SYNERGY_USAGE_LIVE_API_KEY ?? process.env.DEEPSEEK_API_KEY
      if (!credential) throw new Error("The live vision test requires its fixture credential")
      await using runtime = await testRuntime()
      await runtime.run(async () => {
        const image = pngImage(item.size)
        const owner = { kind: "operation" as const, scopeID: "home", operationID: crypto.randomUUID() }
        const request = {
          model: "deepseek-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe the colors in these images in one short sentence." },
                ...Array.from({ length: item.count }, () => ({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${image}` },
                })),
              ],
            },
          ],
          stream: item.stream,
          ...(item.stream ? { stream_options: { include_usage: true } } : {}),
          thinking: { type: "disabled" },
          max_tokens: 96,
        }
        let reported: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined
        await RolloutCall.execute(
          {
            owner,
            runID: "live-vision",
            purpose: "model.validation",
            kind: "chat",
            request,
            model: {
              providerID: "deepseek",
              modelID: request.model,
              sdk: "@ai-sdk/openai-compatible",
              pricing: null,
              billingMode: "api",
            },
          },
          async () => {
            const response = await RolloutTransport.sdkFetch("https://api.deepseek.com/chat/completions", {
              method: "POST",
              headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
              body: JSON.stringify(request),
              signal: AbortSignal.timeout(90000),
            })
            const body = await response.text()
            if (!response.ok) throw new Error(`Live vision provider returned HTTP ${response.status}`)
            const payloads = item.stream
              ? body
                  .split("\n")
                  .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
                  .map((line) => JSON.parse(line.slice(6)))
              : [JSON.parse(body)]
            reported = payloads.findLast((payload) => payload.usage)?.usage
            return { value: undefined, response: { status: response.status } }
          },
        )
        expect(reported).toBeDefined()
        expect(reported!.prompt_tokens).toBeGreaterThan(0)
        expect(reported!.completion_tokens).toBeGreaterThan(0)
        const summary = await UsageQuery.summary({ scopeID: "home" })
        expect(summary.accounting.attempts).toBe(1)
        expect(summary.accounting.tokens.input.total).toBe(reported!.prompt_tokens)
        expect(summary.accounting.tokens.output.total).toBe(reported!.completion_tokens)
        expect(summary.accounting.tokens.total.total).toBe(reported!.total_tokens)
        expect(summary.accounting.apiEstimate.total).toBeNull()
        expect(summary.latestRequest?.responseModel).toBeTruthy()
        expect(summary.latestRequest?.timing?.streaming).toBe(item.stream)
        expect(summary.latestRequest?.timing?.requestMs).toBeGreaterThan(0)
        if (item.stream) expect(summary.latestRequest?.timing?.ttftMs).toBeGreaterThan(0)
        else expect(summary.rates.generation.value).toBeNull()
        const records = JSON.stringify(await UsageQuery.records())
        expect(records).not.toContain(credential)
        expect(records).not.toContain(image.slice(0, 100))
        console.info(
          JSON.stringify({
            liveVision: {
              case: item.name,
              tokens: summary.accounting.tokens,
              responseModel: summary.latestRequest?.responseModel,
              latency: summary.latency,
              rates: summary.rates,
            },
          }),
        )
      })
    },
    120000,
  )
}
