import { describe, expect, test } from "bun:test"
import {
  artifactColumnCount,
  artifactColumns,
  artifactKind,
  formatArtifactSize,
  resolveArtifactUrl,
  type ArtifactFile,
} from "../src/components/artifact-card-utils"

describe("artifact card helpers", () => {
  test("resolves safe artifact URLs", () => {
    const serverUrl = "http://localhost:3000/"

    expect(resolveArtifactUrl(serverUrl, file({ url: "asset://abc123.png" }))).toBe(
      "http://localhost:3000/asset/abc123.png",
    )
    expect(resolveArtifactUrl(serverUrl, file({ assetId: "def456.pdf" }))).toBe(
      "http://localhost:3000/asset/def456.pdf",
    )
    expect(resolveArtifactUrl(serverUrl, file({ url: "data:image/png;base64,AAA" }))).toBe("data:image/png;base64,AAA")
    expect(resolveArtifactUrl(serverUrl, file({ url: "https://example.com/report.pdf" }))).toBe(
      "https://example.com/report.pdf",
    )
    expect(resolveArtifactUrl(serverUrl, file({ url: "file:///tmp/secret.png" }))).toBeUndefined()
  })

  test("labels common artifact kinds and sizes", () => {
    expect(artifactKind(file({ mime: "application/pdf" }))).toBe("PDF")
    expect(artifactKind(file({ mime: "text/csv" }))).toBe("CSV")
    expect(artifactKind(file({ mime: "image/webp" }))).toBe("WEBP")
    expect(
      artifactKind(file({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })),
    ).toBe("DOCX")
    expect(formatArtifactSize(12)).toBe("12 B")
    expect(formatArtifactSize(1536)).toBe("1.5 KB")
  })

  test("uses compact gallery columns", () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ filename: `file-${i}.png` }))

    expect(artifactColumnCount([])).toBe(0)
    expect(artifactColumnCount(files.slice(0, 1))).toBe(1)
    expect(artifactColumnCount(files.slice(0, 2))).toBe(2)
    expect(artifactColumnCount(files)).toBe(3)
    expect(artifactColumns(files).map((column) => column.length)).toEqual([2, 2, 1])
  })
})

function file(input: Partial<ArtifactFile>): ArtifactFile {
  return {
    mime: "image/png",
    ...input,
  }
}
