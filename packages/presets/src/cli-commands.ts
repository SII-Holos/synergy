import { createRuntimeCli } from "@ericsanchezok/synergy-cli/runtime-cli"
import { fullComponents } from "./components"
import { sourceWebApp } from "./server/web-app"

export const fullCommands = (await createRuntimeCli([...fullComponents(), sourceWebApp()])).commands!
