import { Style, Link } from "@solidjs/meta"
import inter from "../assets/fonts/inter.woff2"
import ibmPlexMonoRegular from "../assets/fonts/BlexMonoNerdFontMono-Regular.woff2"
import ibmPlexMonoMedium from "../assets/fonts/BlexMonoNerdFontMono-Medium.woff2"
import ibmPlexMonoBold from "../assets/fonts/BlexMonoNerdFontMono-Bold.woff2"

import cascadiaCode from "../assets/fonts/CaskaydiaCoveNerdFontMono-Regular.woff2"
import cascadiaCodeBold from "../assets/fonts/CaskaydiaCoveNerdFontMono-Bold.woff2"
import firaCode from "../assets/fonts/FiraCodeNerdFontMono-Regular.woff2"
import firaCodeBold from "../assets/fonts/FiraCodeNerdFontMono-Bold.woff2"
import hack from "../assets/fonts/HackNerdFontMono-Regular.woff2"
import hackBold from "../assets/fonts/HackNerdFontMono-Bold.woff2"
import inconsolata from "../assets/fonts/InconsolataNerdFontMono-Regular.woff2"
import inconsolataBold from "../assets/fonts/InconsolataNerdFontMono-Bold.woff2"
import intelOneMono from "../assets/fonts/IntoneMonoNerdFontMono-Regular.woff2"
import intelOneMonoBold from "../assets/fonts/IntoneMonoNerdFontMono-Bold.woff2"
import jetbrainsMono from "../assets/fonts/JetBrainsMonoNerdFontMono-Regular.woff2"
import jetbrainsMonoBold from "../assets/fonts/JetBrainsMonoNerdFontMono-Bold.woff2"
import mesloLgs from "../assets/fonts/MesloLGSNerdFontMono-Regular.woff2"
import mesloLgsBold from "../assets/fonts/MesloLGSNerdFontMono-Bold.woff2"
import robotoMono from "../assets/fonts/RobotoMonoNerdFontMono-Regular.woff2"
import robotoMonoBold from "../assets/fonts/RobotoMonoNerdFontMono-Bold.woff2"
import sourceCodePro from "../assets/fonts/SauceCodeProNerdFontMono-Regular.woff2"
import sourceCodeProBold from "../assets/fonts/SauceCodeProNerdFontMono-Bold.woff2"
import ubuntuMono from "../assets/fonts/UbuntuMonoNerdFontMono-Regular.woff2"
import ubuntuMonoBold from "../assets/fonts/UbuntuMonoNerdFontMono-Bold.woff2"

type MonoFont = {
  family: string
  regular: string
  bold: string
}

export const MONO_NERD_FONTS = [
  {
    family: "JetBrains Mono Nerd Font",
    regular: jetbrainsMono,
    bold: jetbrainsMonoBold,
  },
  {
    family: "Fira Code Nerd Font",
    regular: firaCode,
    bold: firaCodeBold,
  },
  {
    family: "Cascadia Code Nerd Font",
    regular: cascadiaCode,
    bold: cascadiaCodeBold,
  },
  {
    family: "Hack Nerd Font",
    regular: hack,
    bold: hackBold,
  },
  {
    family: "Source Code Pro Nerd Font",
    regular: sourceCodePro,
    bold: sourceCodeProBold,
  },
  {
    family: "Inconsolata Nerd Font",
    regular: inconsolata,
    bold: inconsolataBold,
  },
  {
    family: "Roboto Mono Nerd Font",
    regular: robotoMono,
    bold: robotoMonoBold,
  },
  {
    family: "Ubuntu Mono Nerd Font",
    regular: ubuntuMono,
    bold: ubuntuMonoBold,
  },
  {
    family: "Intel One Mono Nerd Font",
    regular: intelOneMono,
    bold: intelOneMonoBold,
  },
  {
    family: "Meslo LGS Nerd Font",
    regular: mesloLgs,
    bold: mesloLgsBold,
  },
] satisfies MonoFont[]

const monoNerdCss = MONO_NERD_FONTS.map(
  (font) => `
        @font-face {
          font-family: "${font.family}";
          src: url("${font.regular}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 400;
        }
        @font-face {
          font-family: "${font.family}";
          src: url("${font.bold}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 700;
        }`,
).join("")

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
${monoNerdCss}
      `}</Style>
      <Link rel="preload" href={inter} as="font" type="font/woff2" crossorigin="anonymous" />
      <Link rel="preload" href={ibmPlexMonoRegular} as="font" type="font/woff2" crossorigin="anonymous" />
    </>
  )
}
