import { Icon, type LucideProps } from "lucide-solid"

// Tabler photo-edit, @tabler/icons 3.35.0 (MIT): https://github.com/tabler/tabler-icons.
// Keep the selected outline while sharing the host stroke and sizing behavior.
export function PhotoEdit(props: LucideProps) {
  return (
    <Icon
      {...props}
      iconNode={[
        ["path", { d: "M15 8h.01" }],
        ["path", { d: "M11 20h-4a3 3 0 0 1 -3 -3v-10a3 3 0 0 1 3 -3h10a3 3 0 0 1 3 3v4" }],
        ["path", { d: "M4 15l4 -4c.928 -.893 2.072 -.893 3 0l3 3" }],
        ["path", { d: "M14 14l1 -1c.31 -.298 .644 -.497 .987 -.596" }],
        ["path", { d: "M18.42 15.61a2.1 2.1 0 0 1 2.97 2.97l-3.39 3.42h-3v-3l3.42 -3.39z" }],
      ]}
    />
  )
}

// Notion, Simple Icons 13.0.0 (CC0): https://github.com/simple-icons/simple-icons.
// Brand geometry uses currentColor for both host themes.
export function Notion(props: LucideProps) {
  return (
    <Icon
      {...props}
      fill="currentColor"
      stroke="none"
      iconNode={[
        [
          "path",
          {
            d: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
          },
        ],
      ]}
    />
  )
}
