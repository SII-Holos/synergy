import type { SerializedError } from "./protocol.js"

// =============================================================================
// PluginRuntimeError
// =============================================================================

/**
 * An error that occurred during plugin runtime lifecycle.
 * Carries the plugin ID and a machine-readable code so the supervisor
 * can classify and handle failures consistently.
 */
export class PluginRuntimeError extends Error {
  public readonly pluginId: string
  public readonly code: string

  constructor(pluginId: string, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PluginRuntimeError"
    this.pluginId = pluginId
    this.code = code
  }

  override toString(): string {
    return `PluginRuntimeError [${this.pluginId}] ${this.code}: ${this.message}`
  }
}

// =============================================================================
// serializeError
// =============================================================================

/**
 * Convert any error (or error-like value) into a plain {@link SerializedError}
 * object safe for IPC transport. Nested `cause` chains are walked recursively.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
      stack: error.stack ?? undefined,
    }
    if (error.cause && error.cause instanceof Error) {
      serialized.cause = serializeError(error.cause)
    }
    return serialized
  }

  // Non-Error values: coerce to string
  const message = error === null ? "null" : String(error)
  return { name: "Error", message }
}

// =============================================================================
// deserializeError
// =============================================================================

/**
 * Reconstruct an Error (or Error subclass) from a {@link SerializedError} object.
 * Nested `cause` chains are recursively reconstructed.
 */
export function deserializeError(serialized: SerializedError): Error {
  let cause: Error | undefined
  if (serialized.cause) {
    cause = deserializeError(serialized.cause)
  }

  const err = new Error(serialized.message, cause ? { cause } : undefined)
  err.name = serialized.name
  if (serialized.stack) {
    err.stack = serialized.stack
  }
  return err
}

// =============================================================================
// classifyRuntimeExit
// =============================================================================

/**
 * Result of {@link classifyRuntimeExit}.
 */
export type ExitClassification = "normal" | "crash" | "terminated" | "killed" | "signaled"

/**
 * Classify a process exit based on its exit code and signal.
 *
 * @param exitCode  - The numeric exit code, or null if unavailable.
 * @param signalCode - The signal name, or null if the process was not signalled.
 */
export function classifyRuntimeExit(exitCode: number | null, signalCode: string | null): ExitClassification {
  // Signal-based exits take priority over exit codes
  if (signalCode) {
    if (signalCode === "SIGTERM") return "terminated"
    if (signalCode === "SIGKILL") return "killed"
    return "signaled"
  }

  // Exit-code-based classification
  if (exitCode === 0 || exitCode === null) return "normal"
  return "crash"
}
