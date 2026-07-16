import { expect, test } from "bun:test"
import { ConfigSetup } from "../../src/config/setup"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("vision_model requires image input rather than another non-text modality", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const provider = {
        id: "pdf-provider",
        name: "PDF Provider",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        api: "https://example.test/v1",
        models: {
          "pdf-only": {
            id: "pdf-only",
            name: "PDF Only",
            family: "pdf",
            modalities: { input: ["text", "pdf"], output: ["text"] },
            limit: { context: 8_192, output: 1_024 },
          },
        },
      } satisfies NonNullable<ConfigSetup.SetupDraft["provider"]>[string]
      const result = await ConfigSetup.validateRequiredCore({
        model: "pdf-provider/pdf-only",
        vision_model: "pdf-provider/pdf-only",
        provider: { "pdf-provider": provider },
      })

      expect(result.fields.model.valid).toBe(true)
      expect(result.fields.vision_model.valid).toBe(false)
      expect(result.fields.vision_model.message).toBe("Vision model must support image input")
    },
  })
})
