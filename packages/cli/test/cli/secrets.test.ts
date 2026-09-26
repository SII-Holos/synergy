import { afterEach, expect, spyOn, test } from "bun:test"
import * as prompts from "@clack/prompts"
import yargs from "yargs"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { SecretsCommand } from "../../src/cli/cmd/secrets"
import { UI } from "../../src/util/ui"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const invoke = (args: string[]) =>
  yargs(["secrets", ...args])
    .exitProcess(false)
    .command(SecretsCommand)
    .fail((message, error) => {
      throw error ?? new Error(message)
    })
    .parseAsync()
const owned = new Set<string>()

afterEach(() =>
  runtime.run(async () => {
    for (const id of owned) await SecretVault.remove(id)
    owned.clear()
  }),
)

test("secret CLI manages entries without printing plaintext except on explicit reveal", () =>
  runtime.run(async () => {
    const value = `cli-fixture-${crypto.randomUUID()}`
    const next = `cli-rotated-${crypto.randomUUID()}`
    const messages: string[] = []
    const output = spyOn(UI, "println").mockImplementation((...args) => {
      messages.push(args.join(" "))
    })
    const password = spyOn(prompts, "password").mockResolvedValue(value)
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true)
    try {
      await invoke(["register", "--policy-tools", "bash", "save_file"])
      const entry = (await SecretVault.list()).find((item) => messages.join("\n").includes(item.id))!
      owned.add(entry.id)
      expect(entry.policy).toEqual({ tools: ["bash", "save_file"] })
      await invoke(["list"])
      expect(messages.join("\n")).toContain(entry.id)
      expect(messages.join("\n")).not.toContain(value)
      messages.length = 0
      await invoke(["reveal", entry.id])
      expect(messages).toEqual([value])
      messages.length = 0
      password.mockResolvedValue(next)
      await invoke(["rotate", entry.id])
      const rotated = (await SecretVault.list()).find((item) => messages.join("\n").includes(item.id))!
      owned.add(rotated.id)
      expect(rotated.policy).toEqual(entry.policy)
      expect(await SecretVault.reveal(entry.id)).toBeUndefined()
      expect(messages.join("\n")).not.toContain(next)
      confirm.mockResolvedValue(false)
      await expect(invoke(["remove", rotated.id])).rejects.toBeInstanceOf(UI.CancelledError)
      expect(await SecretVault.reveal(rotated.id)).toBe(next)
      confirm.mockResolvedValue(true)
      await invoke(["remove", rotated.id])
      expect(await SecretVault.reveal(rotated.id)).toBeUndefined()
      password.mockResolvedValue("")
      await expect(invoke(["register"])).rejects.toBeInstanceOf(UI.CancelledError)
    } finally {
      output.mockRestore()
      password.mockRestore()
      confirm.mockRestore()
    }
  }))

test("secret CLI preserves rotation conflicts instead of reporting a missing entry", () =>
  runtime.run(async () => {
    const source = await SecretVault.register(`cli-source-${crypto.randomUUID()}`, { kind: "user" })
    const target = await SecretVault.register(`cli-target-${crypto.randomUUID()}`, { kind: "user" })
    owned.add(source.id)
    owned.add(target.id)
    const password = spyOn(prompts, "password").mockResolvedValue(target.value)
    const output = spyOn(UI, "error").mockImplementation(() => {})
    try {
      await expect(invoke(["rotate", source.id])).rejects.toBeInstanceOf(SecretVault.ConflictError)
      expect(await SecretVault.reveal(source.id)).toBe(source.value)
      expect(await SecretVault.reveal(target.id)).toBe(target.value)
      expect(output).not.toHaveBeenCalled()
    } finally {
      password.mockRestore()
      output.mockRestore()
    }
  }))

test("secret CLI reports missing entries for rotation and reveal", () =>
  runtime.run(async () => {
    const password = spyOn(prompts, "password").mockResolvedValue(`cli-missing-${crypto.randomUUID()}`)
    const output = spyOn(UI, "error").mockImplementation(() => {})
    try {
      await expect(invoke(["rotate", "missing"])).rejects.toBeInstanceOf(UI.CancelledError)
      await expect(invoke(["reveal", "missing"])).rejects.toBeInstanceOf(UI.CancelledError)
      expect(output).toHaveBeenCalledTimes(2)
    } finally {
      password.mockRestore()
      output.mockRestore()
    }
  }))

afterRuntimeTests(() => runtime.close())
