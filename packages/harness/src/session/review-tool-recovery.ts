export namespace ReviewToolRecovery {
  export const MAX_ATTEMPTS = 2
  export const ERROR_CODE = "review_terminal_tool_missing"
  export const LAUNCH_ERROR_CODE = "reviewer_launch_failed"

  export function launchError(reason?: string): string {
    return `${LAUNCH_ERROR_CODE}: ${reason ?? "reviewer failed before its first turn"}`
  }

  export function tools(approveTool: string, rejectTool: string): Record<string, boolean> {
    return {
      "*": false,
      [approveTool]: true,
      [rejectTool]: true,
    }
  }

  export function prompt(input: {
    executionSessionID: string
    approveTool: string
    rejectTool: string
    attempt: number
  }): string {
    return [
      "## Review completion recovery",
      "",
      "Your previous review turn ended without a successful terminal review tool call.",
      "Keep the evidence and analysis already present in this reviewer session. Do not search for sessions or repeat completed investigation.",
      `Execution session ID: ${input.executionSessionID}`,
      "",
      `Call exactly one of ${input.approveTool} or ${input.rejectTool} now with the execution session ID above.`,
      "If an earlier call failed, correct its arguments from the recorded tool error.",
      "Do not return a prose-only final response. Finish only after the terminal review tool succeeds.",
      `Recovery attempt: ${input.attempt}/${MAX_ATTEMPTS}`,
    ].join("\n")
  }

  export function exhaustedError(attempts: number): string {
    return `${ERROR_CODE}: reviewer ended without a successful terminal review tool after ${attempts} recovery attempts`
  }
}
