import { afterEach, expect, test } from "bun:test"
import { SandboxHost } from "../../src/sandbox/host"
import type { PrepareWrapperOpts } from "../../src/sandbox/types"

afterEach(() => SandboxHost.register(undefined))

test("sandbox execution fails closed without a composed host", () => {
  expect(() =>
    SandboxHost.prepareWrapper({ command: "sh", args: [], workspace: "/research", sandboxMode: "read_only" }),
  ).toThrow("Sandbox host is not registered")
})

test("sandbox host receives the approved policy and returns its execution wrapper", () => {
  const options: PrepareWrapperOpts = {
    command: "sh",
    args: ["-c", "cat input.txt"],
    workspace: "/research",
    sandboxMode: "read_only",
    extraReadRoots: ["/approved-data"],
    protectedPaths: ["/research/.git"],
    networkMode: "restricted",
  }
  let received: PrepareWrapperOpts | undefined
  SandboxHost.register({
    prepareWrapper(input) {
      received = input
      return { command: "sandbox-host", args: [input.command, ...input.args], sandboxed: true }
    },
  })
  expect(SandboxHost.prepareWrapper(options)).toEqual({
    command: "sandbox-host",
    args: ["sh", "-c", "cat input.txt"],
    sandboxed: true,
  })
  expect(received).toBe(options)
})
