import { RuntimeContext } from "../lifecycle/context"
export namespace SessionProjectHealth {
  export interface Provider {
    isGitRepo(cwd?: string): Promise<boolean>
    /** Cached git-health diagnostics block for the environment prompt;
     * undefined when no report is cached yet (refreshes in the background
     * like the product implementation). */
    injectCachedGitHealth(cwd?: string): string | undefined
    invalidateGitHealth(cwd?: string): void
  }

  const runtimeState = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
  }))

  export function register(value: Provider): void {
    const instanceState = runtimeState()

    if (instanceState.provider === value) return
    RuntimeContext.assertCompositionOpen("session/project-health")
    if (instanceState.provider && value) throw new Error("session/project-health is already registered")
    instanceState.provider = value
  }

  export function get(): Provider | undefined {
    const instanceState = runtimeState()

    return instanceState.provider
  }

  export function isGitRepo(cwd?: string): Promise<boolean> {
    const instanceState = runtimeState()

    return instanceState.provider?.isGitRepo(cwd) ?? Promise.resolve(false)
  }

  export function injectCachedGitHealth(cwd?: string): string | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.injectCachedGitHealth(cwd)
  }

  export function invalidateGitHealth(cwd?: string): void {
    const instanceState = runtimeState()

    instanceState.provider?.invalidateGitHealth(cwd)
  }
}
