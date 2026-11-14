import { expect, test } from "bun:test"
import { OrganizationArtifactProtocol as Artifact, OrganizationKnowledgeProtocol as Knowledge } from "../src/index"

test("publication receipt absence is distinct from a mutation outcome and never carries substituted authority", () => {
  for (const schema of [Knowledge.PublicationReceipt, Artifact.PublicationReceipt]) {
    expect(schema.parse({ state: "missing" })).toEqual({ state: "missing" })
    for (const value of [
      { state: "not_dispatched" },
      { state: "missing", requestID: "other" },
      { state: "published" },
      { state: "missing", token: "secret" },
    ])
      expect(schema.safeParse(value).success).toBe(false)
  }
})
