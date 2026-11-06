import {
  loadPresentation,
  getSlides,
  getSlideText,
  getSlideSize,
  getSlideTables,
  getTableCells,
  getTableCellText,
} from "@office-kit/pptx"
import { renderSlideToSvg } from "@office-kit/pptx-preview"
import { validateOfficePackage } from "./office-package"
import { OfficePreviewError, type OfficeRenderedDocument } from "./office-contract"

export async function parseOfficePresentation(bytes: Uint8Array): Promise<OfficeRenderedDocument> {
  const checked = validateOfficePackage(bytes, "pptx")
  try {
    const presentation = await loadPresentation(checked.bytes)
    const size = getSlideSize(presentation)
    const width = (size?.width ?? 12192000) / 9525,
      height = (size?.height ?? 6858000) / 9525
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 100000 ||
      height > 100000
    )
      throw new OfficePreviewError("unsupported")
    return {
      pages: getSlides(presentation).map((slide) => ({
        html: `<div style="width:${width}px;height:${height}px">${renderSlideToSvg(presentation, slide)}</div>`,
        text: [
          getSlideText(slide),
          ...getSlideTables(slide).flatMap((table) => getTableCells(table).flatMap((row) => row.map(getTableCellText))),
        ].join("\n"),
        width,
      })),
      css: ".office-paper svg{display:block;width:100%;height:100%;}",
    }
  } catch (error) {
    if (error instanceof OfficePreviewError) throw error
    throw new OfficePreviewError("corrupt")
  }
}
