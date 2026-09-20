import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { RolloutTool } from "../../src/session/rollout/tool"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { Identifier } from "../../src/id/id"
import { SecretVault } from "../../src/secrets/vault"
import { SecretMask } from "../../src/secrets/mask"

test("early tool evidence capture masks output before the resolver receives the result", async () => {
  const value = `sk-evidence-${crypto.randomUUID()}`
  const id = SecretVault.idOf(value)
  try {
    await fixture(async ({ rootID, call }) => {
      const result = { output: value, title: value, metadata: { values: [value] } }
      await RolloutTool.execute(
        {
          owner: call.owner,
          runID: rootID,
          messageID: Identifier.ascending("message"),
          toolCallID: "capture-probe",
          tool: "probe",
          args: {},
        },
        async () => {
          await RolloutTool.capture(result)
          expect(result.output).toBe(SecretMask.token(id))
          return result
        },
      )
      const [tool] = await RolloutLedger.tools(call.owner, rootID)
      for (const ref of [tool.rawResult, tool.observation]) {
        if (!ref) throw new Error("Expected captured evidence")
        const chunks: Uint8Array[] = []
        for await (const chunk of RolloutArtifact.read(call.owner, ref.id)) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString()
        expect(text).not.toContain(value)
        expect(text).toContain(SecretMask.token(id))
      }
    })
  } finally {
    await SecretVault.remove(id)
  }
})
