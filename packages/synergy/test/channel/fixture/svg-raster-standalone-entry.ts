import { rasterizeSvgPreview } from "../../../src/channel/provider/feishu/svg-raster"

const png = await rasterizeSvgPreview(
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>'),
)
const signature = Array.from(png.subarray(0, 8))
if (signature.join(",") !== "137,80,78,71,13,10,26,10") throw new Error("SVG preview is not a PNG")
console.log("standalone SVG raster runtime ready")
