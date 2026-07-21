import { Channel } from ".."
import { FeishuProvider } from "./feishu"
import { ClarusProvider } from "./clarus"

let registered = false

export function registerProviders(): void {
  if (registered) return
  registered = true
  Channel.registerProvider(new FeishuProvider())
  Channel.registerProvider(new ClarusProvider())
}
