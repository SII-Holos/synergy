export interface TextPartProjectionInput {
  key: string
  source: string
  completed: boolean
  remove?: string
}

export function isTextPartTerminal(input: { partEnd?: number; messageCompleted?: number }) {
  return input.partEnd !== undefined || input.messageCompleted !== undefined
}

interface IncrementalTransform {
  write(chunk: string): string
  end?(): string
}

function createTrimTransform(): IncrementalTransform {
  let started = false
  let whitespace = ""

  return {
    write(chunk) {
      let output = ""
      for (const character of chunk) {
        if (character.trim().length === 0) {
          if (started) whitespace += character
          continue
        }

        if (!started) started = true
        output += whitespace + character
        whitespace = ""
      }
      return output
    },
  }
}

const pathBoundaryCharacters = new Set(["`", '"', "'", "<", ">", "[", "]", "(", ")", "{", "}", ":", ";", ",", "!", "?"])

function isPathBoundary(character: string) {
  return character.trim().length === 0 || pathBoundaryCharacters.has(character)
}

function createRelativizePathTransform(pattern?: string): IncrementalTransform {
  if (!pattern) return { write: (chunk) => chunk }

  let pending = ""
  return {
    write(chunk) {
      let output = ""
      for (const character of chunk) {
        if (pending === pattern) {
          if (isPathBoundary(character)) output += "."
          else if (character !== "/" && character !== "\\") output += pattern
          pending = ""
        }

        pending += character
        while (pending && !pattern.startsWith(pending)) {
          output += pending[0]
          pending = pending.slice(1)
        }
      }
      return output
    },
    end() {
      const output = pending === pattern ? "." : pending
      pending = ""
      return output
    },
  }
}

function projectCompleteText(source: string, remove?: string) {
  const transform = createRelativizePathTransform(remove)
  return transform.write(source.trim()) + (transform.end?.() ?? "")
}

export function createTextPartProjection() {
  let key: string | undefined
  let remove: string | undefined
  let sourceLength = 0
  let completed = false
  let output = ""
  let trim = createTrimTransform()
  let strip = createRelativizePathTransform()

  const reset = (input: TextPartProjectionInput) => {
    key = input.key
    remove = input.remove
    sourceLength = input.source.length
    completed = input.completed
    trim = createTrimTransform()
    strip = createRelativizePathTransform(remove)
    output = input.completed ? projectCompleteText(input.source, remove) : strip.write(trim.write(input.source))
    return output
  }

  return {
    project(input: TextPartProjectionInput) {
      if (
        key !== input.key ||
        remove !== input.remove ||
        input.source.length < sourceLength ||
        input.completed !== completed
      ) {
        return reset(input)
      }

      if (input.completed) {
        if (input.source.length !== sourceLength) return reset(input)
        return output
      }

      const delta = input.source.slice(sourceLength)
      sourceLength = input.source.length
      if (delta) output += strip.write(trim.write(delta))
      return output
    },
  }
}
