export type OfficeFormat = "docx" | "xlsx" | "pptx"
export type OfficeErrorCode = "too-large" | "corrupt" | "encrypted" | "unsupported" | "failed"
export const OFFICE_INPUT_MAX_BYTES = 50 * 1024 * 1024
export const OFFICE_EXPANDED_MAX_BYTES = 200 * 1024 * 1024
export const OFFICE_MAX_ENTRIES = 4096

export class OfficePreviewError extends Error {
  constructor(readonly code: OfficeErrorCode) {
    super(code)
    this.name = "OfficePreviewError"
  }
}
