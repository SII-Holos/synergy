export function nativeOutcome(kind, events) {
  let result = { status: "unknown", error: null }
  for (const event of events) {
    if (kind === "pi" && event.type === "message_end" && event.message?.role === "assistant") {
      const reason = event.message.stopReason
      result = {
        status:
          reason === "error"
            ? "failed"
            : reason === "aborted"
              ? "cancelled"
              : reason === "toolUse"
                ? "unknown"
                : "completed",
        error: event.message.errorMessage ?? null,
      }
    }
    if (kind === "codex" && ["turn.completed", "turn.failed"].includes(event.type)) {
      result = { status: event.type === "turn.failed" ? "failed" : "completed", error: event.error?.message ?? null }
    }
    if (kind === "opencode" && event.type === "error") {
      result = { status: "failed", error: event.error?.data?.message ?? event.error?.name ?? null }
    }
    if (kind === "opencode" && event.type === "step_finish" && event.part?.reason === "stop") {
      result = { status: "completed", error: null }
    }
  }
  return result
}
