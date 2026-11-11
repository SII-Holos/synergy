import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { projectSharedPart } from "../src/transcript"

const owner = { kind: "session", scopeID: "project-transcript", sessionID: "ses_transcript" } as const
const base = { id: "prt_transcript", sessionID: owner.sessionID, messageID: "msg_transcript" }

test("large shared dialogue keeps complete Unicode bytes in immutable evidence", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const text = "完整的组织对话🙂".repeat(20_000)
    const result = await projectSharedPart({ ...base, type: "text", text }, owner)
    expect(result.part?.type).toBe("text")
    if (result.part?.type !== "text" || result.part.content.kind !== "blob") throw new Error("Expected blob content")
    const bytes: Uint8Array[] = []
    for await (const chunk of RolloutArtifact.read(owner, result.part.content.blobID)) bytes.push(chunk)
    expect(Buffer.concat(bytes).toString("utf8")).toBe(text)
    expect(result.blobs[0]?.bytes).toBe(Buffer.byteLength(text))
  })
})

test("shared tool evidence masks registered credentials and excludes private metadata", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const secret = "private-organization-provider-key"
    await SecretVault.registerMany([secret], { kind: "heuristic", context: "tool_output" })
    const result = await projectSharedPart({
      ...base,
      type: "tool",
      callID: "tool-call",
      tool: "http",
      metadata: { privateEndpoint: "https://private.invalid" },
      state: {
        status: "completed",
        input: { credential: secret },
        output: `Result contains ${secret}`,
        title: "HTTP request",
        metadata: { environment: { API_KEY: secret } },
        time: { start: 1, end: 2 },
      },
    }, owner)
    expect(result.part?.type).toBe("tool")
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("privateEndpoint")
    expect(JSON.stringify(result)).not.toContain("environment")
    expect(JSON.stringify(result)).toContain("⟦sec:")
  })
})

test("attachment projection retains identity without local paths or permanent URLs", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const result = await projectSharedPart({ ...base, type: "attachment", mime: "text/plain", filename: "result.txt", url: "file:///private/result.txt", localPath: "/private/result.txt" }, owner)
    expect(result.part).toEqual({ type: "attachment", filename: "result.txt", mediaType: "text/plain" })
    expect(JSON.stringify(result)).not.toContain("/private")
  })
})

test("shared text uses canonical system-part semantics instead of publishing retired flags", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const result = await projectSharedPart({ ...base, type: "text", text: "System context", synthetic: true }, owner)
    expect(result.part).toEqual({ type: "text", content: { kind: "inline", text: "System context" }, origin: "system" })
    expect(JSON.stringify(result)).not.toContain("synthetic")
  })
})
