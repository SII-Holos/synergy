import {
  createPresentation,
  addBlankSlide,
  addSlideTextBox,
  addSlideShape,
  addSlideTable,
  addSlideImage,
  savePresentation,
  inches,
} from "@office-kit/pptx"
export async function pptxSample() {
  const presentation = createPresentation({ size: "16:9" })
  const first = addBlankSlide(presentation)
  addSlideTextBox(first, { x: inches(0.6), y: inches(0.5), w: inches(8), h: inches(0.8), text: "中文幻灯片标题😀" })
  addSlideTable(first, {
    x: inches(0.6),
    y: inches(1.7),
    w: inches(6),
    h: inches(2),
    rows: [
      ["字段", "值"],
      ["中文表格", "42"],
    ],
  })
  addSlideShape(first, {
    preset: "roundRect",
    x: inches(8),
    y: inches(1.5),
    w: inches(3),
    h: inches(1),
    text: "常见形状",
  })
  const image = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="),
    (c) => c.charCodeAt(0),
  )
  addSlideImage(first, image, { x: inches(8), y: inches(3), w: inches(1), h: inches(1), format: "png" })
  const second = addBlankSlide(presentation)
  addSlideTextBox(second, { x: inches(0.6), y: inches(0.5), w: inches(8), h: inches(1), text: "第二页幻灯片" })
  return await savePresentation(presentation)
}
