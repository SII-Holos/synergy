import { expect, spyOn, test } from "bun:test"
import * as prompts from "@clack/prompts"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { ChannelSetup } from "@ericsanchezok/synergy-channels/channel/setup"
import { testRuntime } from "./support/runtime"

test("the explicitly selected github setup produces only its provider configuration without saving", async () => {
  const answers = ["fixture", "acme/project", "github-workspaces"]
  const printed: string[] = []
  using text = spyOn(prompts, "text").mockImplementation(async () => answers.shift()!)
  using confirm = spyOn(prompts, "confirm").mockResolvedValue(false)
  using select = spyOn(prompts, "select").mockResolvedValue("feishu")
  using password = spyOn(prompts, "password").mockResolvedValue("fixture-secret")
  using message = spyOn(prompts.log, "message").mockImplementation((value) => {
    printed.push(String(value))
  })
  using info = spyOn(prompts.log, "info").mockImplementation(() => {})
  using success = spyOn(prompts.log, "success").mockImplementation(() => {})
  using outro = spyOn(prompts, "outro").mockImplementation(() => {})
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    expect(ChannelSetup.list().map((entry) => entry.id)).toEqual(["github"])
    await ChannelSetup.get("github")!.configure(true, "https://example.invalid", () => {
      throw new Error("Print-only setup cannot start a channel")
    })
    expect(printed).toHaveLength(1)
    const configuration = Config.Info.parse(JSON.parse(printed[0]!))
    expect(Object.keys(configuration.channel ?? {})).toEqual(["github"])
    expect(configuration.channel?.github?.accounts.fixture).toMatchObject({ enabled: true })
    expect((await Config.globalResolved()).channel).toBeUndefined()
  })
})
