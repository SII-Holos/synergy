import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { version } from "../package.json" with { type: "json" }
import { createRuntimeCli } from "@ericsanchezok/synergy-cli/runtime-cli"
import { fullComponents } from "./components"
import { sourceWebApp } from "./server/web-app"

const components = [...fullComponents(), sourceWebApp()]
const features = FeatureSelection.complete(components, { "local-runtime": version, "plugin-host": version })
export const fullCommands = (await createRuntimeCli(components, { features })).commands!
