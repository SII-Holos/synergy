import { afterEach, describe, expect, test } from "bun:test"
import { SecretMask } from "../../src/secrets/mask"
import { SecretVault } from "../../src/secrets/vault"

const tracked: string[] = []

afterEach(async () => {
  for (const id of tracked.splice(0)) await SecretVault.remove(id).catch(() => {})
})

describe("SecretMask engine", () => {
  test("replaces a registered value with its stable token and is idempotent", async () => {
    const value = `sk-test-${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)

    const masked = await SecretMask.apply(`before ${value} after`)
    expect(masked).toBe(`before ${SecretMask.token(entry.id)} after`)

    const again = await SecretMask.apply(masked)
    expect(again).toBe(masked)
  })

  test("the same value always yields the same token across contexts", async () => {
    const value = `ghp_${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)

    const fromTool = await SecretMask.captureAndApply(`token: ${value}`, {
      kind: "heuristic",
      context: "tool_output",
    })
    expect(fromTool).toBe(`token: ${SecretMask.token(entry.id)}`)
  })

  test("captureAndApply registers an unknown secret-shaped value and masks it", async () => {
    const unknown = `ghp_${"a1B2c3D4e5F6g7H8i9J0"}`
    const text = `export GITHUB_TOKEN=${unknown}`
    const masked = await SecretMask.captureAndApply(text, { kind: "heuristic", context: "user_message" })

    expect(masked).not.toContain(unknown)
    expect(masked).toContain("⟦sec:")

    const list = await SecretVault.list()
    const captured = list.find((item) => item.source.kind === "heuristic")
    expect(captured).toBeTruthy()
    if (captured) tracked.push(captured.id)
  })

  test("unregistered free text passes through unchanged", async () => {
    const text = "no secrets here, just prose about sk- patterns"
    expect(await SecretMask.apply(text)).toBe(text)
  })

  test("maskMessages covers message text fields and lateSystem strings", async () => {
    const value = `github_pat_${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)

    const messages = [
      { role: "user", content: [{ type: "text", text: `key is ${value}` }] },
      { role: "tool", content: [{ type: "tool-result", output: value }] },
    ]
    const lateSystem = [`remember ${value}`]
    const changed = await SecretMask.maskMessages(messages, lateSystem)

    expect(changed).toBe(true)
    expect(JSON.stringify(messages)).not.toContain(value)
    expect(JSON.stringify(messages)).toContain(SecretMask.token(entry.id))
    expect(lateSystem[0]).toBe(`remember ${SecretMask.token(entry.id)}`)
  })

  test("maskMessages leaves non-secret fields alone", async () => {
    const value = `sk-live-${crypto.randomUUID()}`
    await SecretVault.register(value, { kind: "user" })
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    expect(await SecretMask.maskMessages(messages)).toBe(false)
  })

  test("transformResult masks output and title in place", async () => {
    const value = `xoxb-${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)

    const result: Record<string, any> = {
      title: `read ${value}`,
      output: `value=${value}`,
      metadata: { nested: { note: value } },
    }
    await SecretMask.transformResult(result)

    expect(result.output).toBe(`value=${SecretMask.token(entry.id)}`)
    expect(result.title).toBe(`read ${SecretMask.token(entry.id)}`)
    expect(result.metadata.nested.note).toBe(SecretMask.token(entry.id))
  })

  test("transformResult captures an unregistered credential echoed by a tool", async () => {
    const echoed = `sk-ant-api03-${crypto.randomUUID()}`
    const result: Record<string, any> = { output: `found ${echoed} in config` }
    await SecretMask.transformResult(result)

    expect(result.output).not.toContain(echoed)
    const id = SecretVault.test.deriveId(echoed)
    const captured = await SecretVault.get(id)
    expect(captured?.source).toMatchObject({ kind: "heuristic", context: "tool_output" })
    tracked.push(id)
  })

  test("maskPart masks user text parts only", async () => {
    const value = `tok_${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)

    const masked = await SecretMask.maskPart({
      type: "text",
      text: `paste ${value}`,
    } as any)
    expect((masked as any).text).toBe(`paste ${SecretMask.token(entry.id)}`)

    const untouched = await SecretMask.maskPart({ type: "file", path: value } as any)
    expect(untouched).toEqual({ type: "file", path: value })
  })
})
