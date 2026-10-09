let cached: Promise<string> | undefined

export function loadRenderFonts() {
  return (cached ??= import("../../fonts")
    .then(async ({ appFonts, fontStyles }) => {
      const sources = new Map(
        await Promise.all(
          appFonts.map(async (font) => {
            const response = await fetch(font.source)
            if (!response.ok) throw new Error(`Font resource failed: ${response.status}`)
            const blob = new Blob([await response.arrayBuffer()], { type: "font/woff2" })
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result))
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(blob)
            })
            return [font.source, data] as const
          }),
        ),
      )
      return fontStyles((source) => sources.get(source)!)
    })
    .catch((error) => {
      cached = undefined
      throw error
    }))
}
