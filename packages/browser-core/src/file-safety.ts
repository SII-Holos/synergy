const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
export const BROWSER_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

export function browserDownloadExceedsLimit(...values: number[]): boolean {
  return values.some((value) => Number.isFinite(value) && value > BROWSER_MAX_DOWNLOAD_BYTES)
}

export function sanitizeBrowserFilename(input: string, fallback = "file"): string {
  const basename = input.normalize("NFC").split(/[\\/]/).pop() ?? ""
  let value = basename
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+$/g, "")
    .slice(0, 240)
  if (!value) value = fallback
  if (WINDOWS_RESERVED_NAME.test(value)) value = `_${value}`
  return value
}
