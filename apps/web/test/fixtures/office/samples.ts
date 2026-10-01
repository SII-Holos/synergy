import { zipSync, strToU8 } from "fflate"

export function docxSample(marker = "中文阅读验收", pageBreak = true) {
  const ns =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const text = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
  const image = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="),
    (c) => c.charCodeAt(0),
  )
  const files: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${rel}officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${rel}styles" Target="styles.xml"/><Relationship Id="header" Type="${rel}header" Target="header1.xml"/><Relationship Id="footer" Type="${rel}footer" Target="footer1.xml"/><Relationship Id="image" Type="${rel}image" Target="media/image.png"/></Relationships>`,
    "word/styles.xml": `<w:styles ${ns}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`,
    "word/header1.xml": `<w:hdr ${ns}>${text("测试页眉")}</w:hdr>`,
    "word/footer1.xml": `<w:ftr ${ns}>${text("测试页脚")}</w:ftr>`,
    "word/media/image.png": image,
    "word/document.xml": `<w:document ${ns}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${marker}</w:t></w:r></w:p>${text("第一页面正文😀")}<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc>${text("字段")}</w:tc><w:tc>${text("值")}</w:tc></w:tr><w:tr><w:tc>${text("中文表格")}</w:tc><w:tc>${text("42")}</w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="image"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>${text("第二页面正文")}<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>`,
  }
  if (!pageBreak)
    files["word/document.xml"] = String(files["word/document.xml"]).replace(
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
      "",
    )
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, typeof bytes === "string" ? strToU8(bytes) : bytes]),
    ),
  )
}
