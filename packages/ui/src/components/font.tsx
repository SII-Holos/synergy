import { Style, Link } from "@solidjs/meta"
import { appFonts, fontStyles } from "../fonts"

export const Font = () => (
  <>
    <Style>{fontStyles()}</Style>
    {appFonts.slice(0, 2).map((font) => (
      <Link rel="preload" href={font.source} as="font" type="font/woff2" crossorigin="anonymous" />
    ))}
  </>
)
