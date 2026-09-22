import { SessionProjectHealth } from "@ericsanchezok/synergy-harness/session/project-health"
import { GitHealth } from "./git-health"

export function registerProjectSessionHealth() {
  SessionProjectHealth.register({
    isGitRepo: (cwd) => GitHealth.isGitRepo(cwd),
    injectCachedGitHealth: (cwd) => GitHealth.injectCached(cwd),
    invalidateGitHealth: (cwd) => GitHealth.invalidate(cwd),
  })
}
