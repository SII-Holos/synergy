import { version } from "../package.json" with { type: "json" }
import { githubAgenda } from "./component"
export const metadata = { id: "github-agenda", version, apiVersion: 1 }
export function registerWorker() {
  githubAgenda().register()
}
