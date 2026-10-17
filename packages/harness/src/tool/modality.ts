import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"

export async function imageToolEligibility(model?: Provider.Model): Promise<ReadonlySet<string>> {
  const eligible = new Set<string>()
  if (model?.capabilities.input.image) eligible.add("view_image")
  if (!model?.capabilities.input.image || model.capabilities.input.supportedImageMediaTypes?.length) {
    const agent = await Agent.get("multimodal-looker")
    const ref = agent && (await Agent.getAvailableModel(agent))
    const vision = ref && (await Provider.getModel(ref.providerID, ref.modelID).catch(() => undefined))
    if (vision?.capabilities.input.image) eligible.add("look_at")
  }
  return eligible
}
