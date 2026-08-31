/**
 * S9c source inversion: the L1 session invoke loop executes commands through
 * this registry instead of importing the command product domain. The L4
 * product manifest registers the implementation; unregistered access throws
 * a registration error on the entry points instead of silently degrading.
 */
export namespace SessionCommandRuntime {
  /** Structural view of a command record as consumed by the invoke loop. */
  export interface CommandInfo {
    name: string
    kind: "prompt" | "action"
    action?: string
    promptVisible?: boolean
    agent?: string
    model?: string
    source?: string
    template?: Promise<string> | string
  }

  export interface CommandResult {
    output: string
    metadata?: Record<string, unknown>
  }

  export interface ExecutedEvent {
    name: string
    sessionID: string
    arguments: string
    messageID: string
  }

  export interface Provider {
    require(name: string): Promise<CommandInfo>
    runAction(input: { action: string; input: unknown; command?: CommandInfo }): Promise<CommandResult>
    unknownActionError(action: string): Error
    notFoundError(name: string): Error
    publishExecuted(event: ExecutedEvent): Promise<void>
    defaultInitCommand: string
  }

  let provider: Provider | undefined

  export function register(value: Provider): void {
    provider = value
  }

  export function get(): Provider | undefined {
    return provider
  }

  function requireProvider(): Provider {
    if (!provider) {
      throw new Error("Command runtime is not registered (load src/product-registration)")
    }
    return provider
  }

  export function require(name: string): Promise<CommandInfo> {
    return requireProvider().require(name)
  }

  export function runAction(input: { action: string; input: unknown; command?: CommandInfo }): Promise<CommandResult> {
    return requireProvider().runAction(input)
  }

  export function unknownActionError(action: string): Error {
    return requireProvider().unknownActionError(action)
  }

  export function notFoundError(name: string): Error {
    return requireProvider().notFoundError(name)
  }

  export function publishExecuted(event: ExecutedEvent): Promise<void> {
    return requireProvider().publishExecuted(event)
  }

  export function defaultInitCommand(): string {
    return requireProvider().defaultInitCommand
  }
}
