import { version } from "../package.json" with { type: "json" }
export const metadata = { id: "formatter", version, apiVersion: 1 }
import { registerConfig } from "./config-schema"
import { FormatterProcess } from "./process"

export function registerWorker() {
  FormatterProcess.register()
  registerConfig()
}
