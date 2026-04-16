import { Channel } from ".."
import { FeishuProvider } from "./feishu"

let registered = false

export function registerProviders(): void {
  if (registered) return
  registered = true
  Channel.registerProvider(new FeishuProvider())
}
