export function experiencePreview(content: string, scriptPreview?: string | null) {
  const paragraphs = content
    .trim()
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  return {
    title: paragraphs[0] ?? "",
    summary: scriptPreview?.trim().replace(/\s+/g, " ") || paragraphs.slice(1).join("\n\n"),
  }
}
