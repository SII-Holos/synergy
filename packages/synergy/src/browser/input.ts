import type { Page } from "playwright"
import type { CDPHandle } from "./cdp.js"

export type BrowserMouseButton = "left" | "middle" | "right"

export interface BrowserKeyInput {
  key: string
  code?: string
  text?: string
  modifiers?: string[]
  autoRepeat?: boolean
}

export interface BrowserMouseInput {
  x: number
  y: number
  button?: BrowserMouseButton
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: string[]
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function normalizeButton(button: unknown): BrowserMouseButton {
  return button === "middle" || button === "right" ? button : "left"
}

function normalizeModifiers(modifiers: unknown): string[] {
  if (!Array.isArray(modifiers)) return []
  return modifiers.filter((m): m is string => typeof m === "string")
}

export class BrowserInputDispatcher {
  constructor(
    private page: Page,
    private getCDP: () => Promise<CDPHandle>,
  ) {}

  private async point(input: BrowserMouseInput): Promise<{ x: number; y: number }> {
    const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 }
    return {
      x: Math.round(clamp(input.x, 0, viewport.width)),
      y: Math.round(clamp(input.y, 0, viewport.height)),
    }
  }

  async mouseMove(input: BrowserMouseInput): Promise<void> {
    const p = await this.point(input)
    await this.page.mouse.move(p.x, p.y)
  }

  async mouseDown(input: BrowserMouseInput): Promise<void> {
    const p = await this.point(input)
    await this.page.mouse.move(p.x, p.y)
    await this.page.mouse.down({
      button: normalizeButton(input.button),
      clickCount: input.clickCount ?? 1,
    })
  }

  async mouseUp(input: BrowserMouseInput): Promise<void> {
    const p = await this.point(input)
    await this.page.mouse.move(p.x, p.y)
    await this.page.mouse.up({
      button: normalizeButton(input.button),
      clickCount: input.clickCount ?? 1,
    })
  }

  async mouseWheel(input: BrowserMouseInput): Promise<void> {
    await this.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0)
  }

  async keyDown(input: BrowserKeyInput): Promise<void> {
    await this.page.keyboard.down(input.key)
  }

  async keyUp(input: BrowserKeyInput): Promise<void> {
    await this.page.keyboard.up(input.key)
  }

  async insertText(text: string): Promise<void> {
    const cdp = await this.getCDP()
    await cdp.send("Input.insertText", { text })
  }
}

export namespace BrowserInput {
  export function modifiers(input: unknown): string[] {
    return normalizeModifiers(input)
  }
}
