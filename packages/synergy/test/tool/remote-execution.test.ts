import { describe, expect, test } from "bun:test"
import { RemoteExecution } from "../../src/tool/remote-execution"

describe("remote execution helpers", () => {
  test("normalizes local aliases to local targets", () => {
    expect(RemoteExecution.resolveTarget(":local")).toEqual({ kind: "local" })
    expect(RemoteExecution.resolveTarget("localhost")).toEqual({ kind: "local" })
  })

  test("rejects placeholder env IDs with guidance", () => {
    expect(() => RemoteExecution.resolveTarget("undefined")).toThrow(
      'Invalid envID "undefined". This looks like a placeholder value, not a real remote environment ID.',
    )
  })

  test("rejects non-env_ prefixed values", () => {
    expect(() => RemoteExecution.resolveTarget("/omit")).toThrow('must start with "env_"')
    expect(() => RemoteExecution.resolveTarget(":bad")).toThrow('must start with "env_"')
    expect(() => RemoteExecution.resolveTarget(":(")).toThrow('must start with "env_"')
  })

  test("remote execution not connected error explains the fix", () => {
    const error = new RemoteExecution.NotConnectedError("env_test", "bash")
    expect(error.message).toContain("This tool call is being treated as remote because envID was provided")
    expect(error.message).toContain("do NOT include the envID parameter at all")
  })

  test("missing remote session error explains the fix", () => {
    const error = new RemoteExecution.NoSessionError("env_test")
    expect(error.message).toContain('No active remote session for env "env_test"')
    expect(error.message).toContain("do NOT include the envID parameter at all")
    expect(error.message).toContain("open a session first with the connect tool")
  })
})
