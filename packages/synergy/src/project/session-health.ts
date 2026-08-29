import { SessionProjectHealth } from "../session/project-health"
import { GitHealth } from "./git-health"
import { Worktree } from "./worktree"

/**
 * S9c source inversion: the L1 session domain reaches the project domain
 * (git health diagnostics, worktree workspace operations) through the
 * SessionProjectHealth registry instead of importing the project product
 * domain. Loaded through src/product-registration.ts.
 */
export function registerProjectSessionHealth() {
  SessionProjectHealth.register({
    isGitRepo: (cwd) => GitHealth.isGitRepo(cwd),
    injectCachedGitHealth: (cwd) => GitHealth.injectCached(cwd),
    invalidateGitHealth: (cwd) => GitHealth.invalidate(cwd),
    lockWorktree: (directory) => Worktree.lock(directory),
    unlockWorktree: (directory) => Worktree.unlock(directory),
    withWorktree: (directory, sessionID, fn) => Worktree.withUse(directory, sessionID, fn),
    createWorktree: (input) => Worktree.create(input),
    enterWorktree: (input) => Worktree.enter(input),
    detachWorktreeSession: (sessionID) => Worktree.detachSession(sessionID),
  })
}
