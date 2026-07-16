import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"

function residual(onCancel: () => void) {
  return {
    async cancel() {
      onCancel()
    },
  }
}

describe("LLM stream ownership", () => {
  test("collectText cancels the branch retained by the AI SDK text promise", async () => {
    let cancellations = 0
    const result: any = {
      get text() {
        this.baseStream = residual(() => cancellations++)
        return Promise.resolve("complete text")
      },
    }

    expect(await LLM.collectText(result)).toBe("complete text")
    expect(cancellations).toBe(1)
  })

  test("takeTextStream cancels the branch retained by the AI SDK text stream", async () => {
    let cancellations = 0
    const result: any = {
      get textStream() {
        this.baseStream = residual(() => cancellations++)
        return (async function* () {
          yield "a"
          yield "b"
        })()
      },
    }

    const owned = LLM.takeTextStream(result)
    let text = ""
    try {
      for await (const chunk of owned.stream) text += chunk
    } finally {
      await owned.dispose()
    }

    expect(text).toBe("ab")
    expect(cancellations).toBe(1)
  })

  test("releases one residual branch for every completed turn", async () => {
    let cancellations = 0
    for (let turn = 0; turn < 100; turn++) {
      const result: any = {
        get fullStream() {
          this.baseStream = residual(() => cancellations++)
          return (async function* () {
            yield { type: "finish" }
          })()
        },
      }
      const owned = LLM.takeFullStream(result)
      try {
        for await (const part of owned.stream) void part
      } finally {
        await owned.dispose()
      }
    }

    expect(cancellations).toBe(100)
  })
})
