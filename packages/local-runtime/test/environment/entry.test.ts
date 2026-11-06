import { expect, test } from "bun:test"
import { z } from "zod"
import { startExecutionHost } from "../../src/environment/entry"

test("the execution-host entry rejects absent allocation identity before opening host resources", async () => {
  const previous = process.env.SYNERGY_EXECUTION_TARGET
  try {
    delete process.env.SYNERGY_EXECUTION_TARGET
    const failure = await startExecutionHost().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(z.ZodError)
    expect(failure).toMatchObject({ issues: [expect.objectContaining({ path: [], code: "invalid_type" })] })
  } finally {
    if (previous === undefined) delete process.env.SYNERGY_EXECUTION_TARGET
    else process.env.SYNERGY_EXECUTION_TARGET = previous
  }
})
