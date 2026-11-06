import { createServerCommand } from "@ericsanchezok/synergy-cli/cli/server"
import { run } from "../server/runtime"

export const ServerCommand = createServerCommand(run)
