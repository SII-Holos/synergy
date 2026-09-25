import { createRuntimeCli } from "@ericsanchezok/synergy-cli/runtime-cli"
import { fullComponents } from "./components"
import { presetWebApp } from "./server/web-app"

export const fullCommands = (await createRuntimeCli([...fullComponents(), presetWebApp()])).commands!
