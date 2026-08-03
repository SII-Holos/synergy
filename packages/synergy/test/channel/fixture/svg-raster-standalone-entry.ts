import { rasterizeSvgPreview } from "../../../src/channel/provider/feishu/svg-raster"

const png = await rasterizeSvgPreview(
  new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="100%" height="100%" fill="white"/><text x="20" y="78" font-size="48" fill="black">Hello 中文</text></svg>',
  ),
)
const signature = Array.from(png.subarray(0, 8))
if (signature.join(",") !== "137,80,78,71,13,10,26,10") throw new Error("SVG preview is not a PNG")
if (png.byteLength < 1_000) throw new Error("SVG preview did not render bundled font glyphs")
console.log("standalone SVG raster runtime ready")
