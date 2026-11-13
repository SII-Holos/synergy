import { expect, test } from "bun:test"
import { downloadIdleDeadline } from "../src/organization/transfer-deadline"

test("positive transfer progress renews idle time while empty progress cannot keep a transfer alive", async () => {
  const deadline = downloadIdleDeadline(new AbortController().signal, 100)
  try {
    for (let index = 0; index < 5; index++) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      deadline.progress(1)
      expect(deadline.signal.aborted).toBe(false)
    }
    expect(() => deadline.progress(0)).toThrow()
    await new Promise((resolve) => setTimeout(resolve, 130))
    expect(deadline.signal.aborted).toBe(true)
  } finally {
    deadline.dispose()
  }
})
