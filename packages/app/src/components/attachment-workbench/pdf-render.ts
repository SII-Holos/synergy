export interface PdfRenderTask {
  promise: Promise<unknown>
  cancel(): void
}

export interface PdfRenderRequest<Page> {
  loadPage(): Promise<Page>
  drawPage(page: Page): PdfRenderTask
  onError(cause: unknown): void
}

function isRenderCancellation(cause: unknown) {
  return cause instanceof Error && cause.name === "RenderingCancelledException"
}

export function createPdfRenderCoordinator<Page>() {
  let generation = 0
  let activeTask: PdfRenderTask | undefined

  const cancelActiveTask = () => {
    activeTask?.cancel()
    activeTask = undefined
  }

  return {
    async render(request: PdfRenderRequest<Page>) {
      const currentGeneration = ++generation
      cancelActiveTask()
      let task: PdfRenderTask | undefined

      try {
        const page = await request.loadPage()
        if (currentGeneration !== generation) return
        task = request.drawPage(page)
        if (currentGeneration !== generation) {
          task.cancel()
          return
        }
        activeTask = task
        await task.promise
      } catch (cause) {
        if (currentGeneration !== generation || isRenderCancellation(cause)) return
        request.onError(cause)
      } finally {
        if (activeTask === task) activeTask = undefined
      }
    },
    cancel() {
      generation++
      cancelActiveTask()
    },
  }
}
