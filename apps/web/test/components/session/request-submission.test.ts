import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRequestSubmission } from "../../../src/components/session/request-submission"

test("a pending decision locks only its own request and cannot submit twice", async () => {
  const action = createRoot(() => createRequestSubmission())
  let release!: () => void
  let calls = 0
  const submit = () => {
    calls++
    return new Promise<void>((resolve) => {
      release = resolve
    })
  }
  const first = action.run("session-a/request-1", { submit, isPending: async () => true })
  await action.run("session-a/request-1", { submit, isPending: async () => true })
  expect(calls).toBe(1)
  expect(action.state("session-a/request-1").status).toBe("pending")
  expect(action.state("session-b/request-2").status).toBe("idle")
  release()
  await first
  expect(action.state("session-a/request-1").status).toBe("settled")
})

test("failed requests retain diagnostics and reconcile before retry", async () => {
  const action = createRoot(() => createRequestSubmission())
  let sends = 0
  let reads = 0
  const failure = { name: "ServiceUnavailable", data: { message: "Connection failed" } }
  const operation = {
    submit: async () => {
      if (++sends === 1) throw failure
    },
    isPending: async () => {
      reads++
      return true
    },
  }
  await action.run("one", operation)
  expect(action.state("one")).toMatchObject({ status: "error", error: failure })
  await action.run("one", operation)
  expect(sends).toBe(2)
  expect(reads).toBe(2)
  expect(action.state("one").status).toBe("settled")
})

test("a lost reply never repeats a decision already removed by the server", async () => {
  const action = createRoot(() => createRequestSubmission())
  let sends = 0
  await action.run("one", {
    submit: async () => {
      sends++
      throw new Error("lost reply")
    },
    isPending: async () => false,
  })
  await action.run("one", {
    submit: async () => {
      sends++
    },
    isPending: async () => false,
  })
  expect(sends).toBe(1)
  expect(action.state("one").status).toBe("settled")
})

test("failed reconciliation keeps the outcome unknown and blocks blind resend", async () => {
  const action = createRoot(() => createRequestSubmission())
  let sends = 0
  const operation = {
    submit: async () => {
      sends++
      throw new Error("lost reply")
    },
    isPending: async () => {
      throw new Error("offline")
    },
  }
  await action.run("one", operation)
  expect(action.state("one").status).toBe("unknown")
  await action.run("one", operation)
  expect(sends).toBe(1)
  expect(action.state("one").status).toBe("unknown")
})
