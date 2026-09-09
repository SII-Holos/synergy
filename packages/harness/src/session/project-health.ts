/**
 * S9c source inversion: the L1 session domain reaches the project product
 * domain (git health diagnostics and worktree workspace operations) through
 * this registry instead of importing it. The L4 product manifest registers
 * the implementation; unregistered access degrades quietly (not a git repo,
 * no diagnostics block, no worktree locking or binding).
 */
export namespace SessionProjectHealth {
  export interface Provider {
    isGitRepo(cwd?: string): Promise<boolean>
    /** Cached git-health diagnostics block for the environment prompt;
     * undefined when no report is cached yet (refreshes in the background
     * like the product implementation). */
    injectCachedGitHealth(cwd?: string): string | undefined
    invalidateGitHealth(cwd?: string): void
    lockWorktree(directory: string): Promise<unknown>
    unlockWorktree(directory: string): Promise<void>
    withWorktree<T>(directory: string, sessionID: string | undefined, fn: () => Promise<T>): Promise<T>
    createWorktree(input: {
      sessionID: string
      name?: string
      baseRef: "current" | "fresh"
      baseRevision?: string
      bind: boolean
    }): Promise<unknown>
    enterWorktree(input: { sessionID: string; target: string; force?: boolean }): Promise<unknown>
    detachWorktreeSession(sessionID: string): Promise<void>
  }

  let provider: Provider | undefined

  export function register(value: Provider): void {
    provider = value
  }

  export function get(): Provider | undefined {
    return provider
  }

  export function isGitRepo(cwd?: string): Promise<boolean> {
    return provider?.isGitRepo(cwd) ?? Promise.resolve(false)
  }

  export function injectCachedGitHealth(cwd?: string): string | undefined {
    return provider?.injectCachedGitHealth(cwd)
  }

  export function invalidateGitHealth(cwd?: string): void {
    provider?.invalidateGitHealth(cwd)
  }

  export function lockWorktree(directory: string): Promise<unknown> {
    return provider?.lockWorktree(directory) ?? Promise.resolve()
  }

  export function unlockWorktree(directory: string): Promise<void> {
    return provider?.unlockWorktree(directory) ?? Promise.resolve()
  }

  export function withWorktree<T>(directory: string, sessionID: string | undefined, fn: () => Promise<T>): Promise<T> {
    return provider ? provider.withWorktree(directory, sessionID, fn) : fn()
  }

  export function createWorktree(input: {
    sessionID: string
    name?: string
    baseRef: "current" | "fresh"
    baseRevision?: string
    bind: boolean
  }): Promise<unknown> {
    if (!provider) {
      return Promise.reject(new Error("Project worktree provider is not registered (load src/product-registration)"))
    }
    return provider.createWorktree(input)
  }

  export function enterWorktree(input: { sessionID: string; target: string; force?: boolean }): Promise<unknown> {
    if (!provider) {
      return Promise.reject(new Error("Project worktree provider is not registered (load src/product-registration)"))
    }
    return provider.enterWorktree(input)
  }

  export function detachWorktreeSession(sessionID: string): Promise<void> {
    return provider?.detachWorktreeSession(sessionID) ?? Promise.resolve()
  }
}
