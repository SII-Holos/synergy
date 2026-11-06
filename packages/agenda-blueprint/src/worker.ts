import { version } from "../package.json" with { type: "json" }
import { agendaBlueprint } from "./component"
export const metadata = { id: "agenda-blueprint", version, apiVersion: 1 }
export function registerWorker() {
  agendaBlueprint().register()
}
