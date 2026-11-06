import { version } from "../package.json" with { type: "json" }
import { agendaLightLoop } from "./component"
export const metadata = { id: "agenda-light-loop", version, apiVersion: 1 }
export function registerWorker() {
  agendaLightLoop().register()
}
