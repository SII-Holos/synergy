import type { Locator } from "playwright"

export async function renderedTextContrast(element: Locator, pseudo?: string) {
  return element.evaluate((element, pseudo) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    const color = (input: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = input
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data, (value) => value / 255)
    }
    const over = (foreground: number[], background: number[]) => [
      ...foreground.slice(0, 3).map((value, i) => value * foreground[3] + background[i] * (1 - foreground[3])),
      1,
    ]
    const ancestors: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
    const background = ancestors.reduce(
      (surface, node) => over(color(getComputedStyle(node).backgroundColor), surface),
      [1, 1, 1, 1],
    )
    const style = getComputedStyle(element, pseudo)
    const foreground = color(style.color)
    foreground[3] *= Number(style.opacity)
    const luminance = (rgb: number[]) =>
      rgb
        .slice(0, 3)
        .reduce(
          (sum, value, i) =>
            sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i],
          0,
        )
    const a = luminance(over(foreground, background)),
      b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, pseudo)
}
