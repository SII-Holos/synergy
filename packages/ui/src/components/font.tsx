import { Style, Link } from "@solidjs/meta"
import inter from "../assets/fonts/inter.woff2"
import ibmPlexMonoRegular from "../assets/fonts/BlexMonoNerdFontMono-Regular.woff2"
import ibmPlexMonoMedium from "../assets/fonts/BlexMonoNerdFontMono-Medium.woff2"
import ibmPlexMonoBold from "../assets/fonts/BlexMonoNerdFontMono-Bold.woff2"

export const Font = () => {
  return (
    <>
      <Style>{`
        @font-face {
          font-family: "Inter";
          src: url("${inter}") format("woff2-variations");
          font-display: swap;
          font-style: normal;
          font-weight: 100 900;
        }
        @font-face {
          font-family: "Inter Fallback";
          src: local("Arial");
          size-adjust: 100%;
          ascent-override: 97%;
          descent-override: 25%;
          line-gap-override: 1%;
        }
        @font-face {
          font-family: "IBM Plex Mono";
          src: url("${ibmPlexMonoRegular}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 400;
        }
        @font-face {
          font-family: "IBM Plex Mono";
          src: url("${ibmPlexMonoMedium}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 500;
        }
        @font-face {
          font-family: "IBM Plex Mono";
          src: url("${ibmPlexMonoBold}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 700;
        }
        @font-face {
          font-family: "IBM Plex Mono Fallback";
          src: local("Courier New");
          size-adjust: 100%;
          ascent-override: 97%;
          descent-override: 25%;
          line-gap-override: 1%;
        }
      `}</Style>
      <Link rel="preload" href={inter} as="font" type="font/woff2" crossorigin="anonymous" />
      <Link rel="preload" href={ibmPlexMonoRegular} as="font" type="font/woff2" crossorigin="anonymous" />
    </>
  )
}
