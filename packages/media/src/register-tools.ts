import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SpeakTool } from "./tools/speak"
import { OpenAIImageGenTool } from "./tools/openai-image-gen"
import { OpenAIImageEditTool } from "./tools/openai-image-edit"
import { LookAtTool } from "./tools/lookat"
import { ScanDocumentTool } from "./tools/scan-document"
import { RenderTool } from "./tools/render"
import { CodexProvider } from "@ericsanchezok/synergy-harness/provider/codex"
import { voiceCapabilityEnabled } from "./config-schema"

export function registerMediaTools() {
  Tool.registerInputHistory("media", { render: { title: "artifactTitle" } })
  ToolRegistry.registerToolProvider("media", async () => {
    const config = await Config.current()
    const tools: Tool.Info[] = [LookAtTool, ScanDocumentTool, RenderTool]
    if (voiceCapabilityEnabled(config.voice?.tts)) tools.push(SpeakTool)
    const access = await CodexProvider.resolveToken({ allowMissing: true, refreshIfExpiring: false }).catch(
      () => undefined,
    )
    if (access) tools.push(OpenAIImageGenTool, OpenAIImageEditTool)
    return tools
  })
}
