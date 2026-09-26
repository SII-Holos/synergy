export const BROWSER_NATIVE_RECOVERY_FAILURE_MESSAGES = {
  unresponsive: "The Desktop native Browser kept becoming unresponsive; automatic recovery stopped.",
  budget: "The Desktop native Browser exhausted its automatic recovery budget.",
  repeated: "The Desktop native Browser could not recover after repeated attempts.",
} as const

export type BrowserNativeRecoveryFailure = keyof typeof BROWSER_NATIVE_RECOVERY_FAILURE_MESSAGES

export function browserNativeRecoveryFailureMessage(kind: BrowserNativeRecoveryFailure): string {
  return BROWSER_NATIVE_RECOVERY_FAILURE_MESSAGES[kind]
}

export function isBrowserNativeRecoveryFailure(message: string): boolean {
  return Object.values(BROWSER_NATIVE_RECOVERY_FAILURE_MESSAGES).some(
    (failure) => message === failure || message.startsWith(`${failure};`),
  )
}
