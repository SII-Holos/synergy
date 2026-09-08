interface DisplayCaptureWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

export function isBrowserDisplayCapturePermission(permission: string): boolean {
  return permission === "media" || permission === "display-capture"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

function controllerCaptureError(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== false) return
  if ("message" in result && typeof result.message === "string") return result.message
  return "Unknown controller error"
}

export async function startBrowserDisplayCapture(
  contents: DisplayCaptureWebContents,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Browser Host display capture timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    )
  })
  try {
    const result = await Promise.race([
      contents.executeJavaScript(
        `startCapture().then(
          () => ({ ok: true }),
          (error) => ({
            ok: false,
            message: String(error?.name ? \`\${error.name}: \${error.message || error}\` : error?.message || error),
          }),
        )`,
        true,
      ),
      timeout,
    ])
    const message = controllerCaptureError(result)
    if (message) throw new Error(message)
  } catch (error) {
    throw new Error(`Browser Host display capture failed: ${errorMessage(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
