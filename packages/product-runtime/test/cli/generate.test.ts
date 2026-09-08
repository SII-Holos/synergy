import { expect, test } from "bun:test"
import { GenerateCommand } from "../../src/cli/generate"
import { productCommands } from "../../src/cli-commands"
import { Access } from "../../src/access"

test("full API generation emits SDK examples for every published operation", async () => {
  const chunks: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((chunk: string, callback: (error?: Error | null) => void) => {
    chunks.push(chunk)
    callback()
    return true
  }) as typeof write
  try {
    await GenerateCommand.handler()
  } finally {
    process.stdout.write = write
  }
  const spec = JSON.parse(chunks.join("")) as {
    paths: Record<string, Record<string, { operationId?: string; "x-codeSamples"?: Array<{ source: string }> }>>
  }
  const operations = Object.values(spec.paths)
    .flatMap((path) => Object.values(path))
    .filter((operation) => operation.operationId)
  expect(operations.length).toBeGreaterThan(300)
  for (const operation of operations) {
    expect(operation["x-codeSamples"]?.[0]?.source).toContain(`await client.${operation.operationId}({`)
  }
})

test("every advertised full product command resolves to an executable command module", async () => {
  for (const entry of productCommands) {
    const command = await entry.load()
    expect(command.command).toEqual(entry.command)
    expect(command.handler || command.builder).toBeDefined()
  }
})

test("frontend access environment shares the normalized runtime endpoint", () => {
  expect(Access.frontendEnv("http://127.0.0.1:4123///")).toEqual({
    VITE_SYNERGY_SERVER_URL: "http://127.0.0.1:4123",
    VITE_SYNERGY_CALLBACK_URL: "http://127.0.0.1:4123/holos/callback",
  })
})
