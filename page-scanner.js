/* Overleaf Comment Exporter — pure page scanner helpers. */

;(function exposeScanner(root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.__olceScanner = api
  }
})(typeof globalThis === 'object' ? globalThis : this, function createScanner() {
  'use strict'

  function snapshotToCodeMirrorOffset(snapshotOffset, trackedChanges) {
    const deletes = toArray(
      typeof trackedChanges?.asSorted === 'function'
        ? trackedChanges.asSorted()
        : trackedChanges
    )
      .filter(change => change?.tracking?.type === 'delete')
      .map(change => rangeBounds(change.range))
      .filter(Boolean)
      .sort((left, right) => left.start - right.start)

    let deletedLength = 0

    for (const deletion of deletes) {
      if (snapshotOffset < deletion.start) {
        break
      }

      if (snapshotOffset <= deletion.end) {
        return deletion.start - deletedLength
      }

      deletedLength += deletion.end - deletion.start
    }

    return snapshotOffset - deletedLength
  }

  function buildSelection(content, startOffset, endOffset) {
    validateRange(content, startOffset, endOffset)

    const lines = content.split('\n')
    const lineStarts = [0]
    for (let offset = 0; offset < content.length; offset += 1) {
      if (content[offset] === '\n') {
        lineStarts.push(offset + 1)
      }
    }

    const start = positionAt(startOffset, lineStarts)
    const end = positionAt(endOffset, lineStarts)
    const contextStartLine = Math.max(1, start.line - 2)
    const contextEndLine = Math.min(lines.length, end.line + 2)
    const contextLines = []

    for (let line = contextStartLine; line <= contextEndLine; line += 1) {
      contextLines.push({ number: line, text: lines[line - 1] })
    }

    return {
      offset: { start: startOffset, end: endOffset },
      start,
      end,
      selectedText: content.slice(startOffset, endOffset),
      context: {
        startLine: contextStartLine,
        endLine: contextEndLine,
        lines: contextLines,
      },
    }
  }

  function normalizeLegacyLocations(stateValues, documentId, content) {
    const stateValue = findLegacyStateValue(stateValues)
    if (!stateValue) {
      return []
    }

    const locations = new Map()
    const resolvedThreads = stateValue.threads

    for (const comment of stateValue.ranges.comments) {
      const op = comment?.op
      if (
        !op ||
        op.t == null ||
        !Number.isInteger(op.p) ||
        typeof op.c !== 'string'
      ) {
        continue
      }

      const thread = getThread(resolvedThreads, op.t)
      addSelection(
        locations,
        op.t,
        stateValue.ranges.docId,
        Boolean(comment.resolved || thread?.resolved),
        buildSelection(content, op.p, op.p + op.c.length)
      )
    }

    return Array.from(locations.values())
  }

  function normalizeHistoryLocations(stateValues, documentId, content) {
    const stateValue = findHistoryStateValue(stateValues)
    if (!stateValue) {
      return []
    }

    const locations = new Map()
    const trackedChanges = stateValue.trackedChanges.asSorted()

    for (const entry of toArray(stateValue.comments)) {
      const comment = mapEntryValue(entry)
      if (!comment || comment.id == null || !isIterable(comment.ranges)) {
        continue
      }

      for (const range of comment.ranges) {
        const bounds = rangeBounds(range)
        if (!bounds) {
          continue
        }

        const start = snapshotToCodeMirrorOffset(
          bounds.start,
          trackedChanges
        )
        const end = snapshotToCodeMirrorOffset(bounds.end, trackedChanges)
        addSelection(
          locations,
          comment.id,
          documentId,
          Boolean(comment.resolved),
          buildSelection(content, start, end)
        )
      }
    }

    return Array.from(locations.values())
  }

  function normalizeCommentLocations(state, documentId, content) {
    const stateValues = state?.values

    if (findLegacyStateValue(stateValues)) {
      return normalizeLegacyLocations(stateValues, documentId, content)
    }

    if (findHistoryStateValue(stateValues)) {
      return normalizeHistoryLocations(stateValues, documentId, content)
    }

    return []
  }

  function addSelection(
    locations,
    threadId,
    documentId,
    resolved,
    selection
  ) {
    let location = locations.get(threadId)

    if (!location) {
      location = {
        threadId,
        documentId,
        resolved,
        selections: [],
      }
      locations.set(threadId, location)
    } else if (resolved) {
      location.resolved = true
    }

    location.selections.push(selection)
  }

  function findLegacyStateValue(stateValues) {
    return toArray(stateValues).find(
      value =>
        value?.ranges?.docId != null &&
        Array.isArray(value.ranges.comments)
    )
  }

  function findHistoryStateValue(stateValues) {
    return toArray(stateValues).find(
      value =>
        isIterable(value?.comments) &&
        typeof value?.trackedChanges?.asSorted === 'function'
    )
  }

  function getThread(threads, threadId) {
    if (!threads) {
      return undefined
    }

    if (typeof threads.get === 'function') {
      return threads.get(threadId)
    }

    return threads[threadId]
  }

  function rangeBounds(range) {
    if (!range) {
      return null
    }

    const start = Number.isInteger(range.pos)
      ? range.pos
      : Number.isInteger(range.start)
        ? range.start
        : null
    const end = Number.isInteger(range.end)
      ? range.end
      : start != null && Number.isInteger(range.length)
        ? start + range.length
        : null

    if (start == null || end == null || start < 0 || end < start) {
      return null
    }

    return { start, end }
  }

  function positionAt(offset, lineStarts) {
    let low = 0
    let high = lineStarts.length - 1

    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (lineStarts[middle] <= offset) {
        low = middle
      } else {
        high = middle - 1
      }
    }

    return {
      line: low + 1,
      column: offset - lineStarts[low] + 1,
    }
  }

  function validateRange(content, start, end) {
    if (typeof content !== 'string') {
      throw new TypeError('Document content must be a string')
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > content.length
    ) {
      throw new RangeError('Selection offsets must form a valid range')
    }
  }

  function isIterable(value) {
    return value != null && typeof value[Symbol.iterator] === 'function'
  }

  function toArray(value) {
    return isIterable(value) ? Array.from(value) : []
  }

  function mapEntryValue(value) {
    return Array.isArray(value) && value.length === 2 ? value[1] : value
  }

  return {
    snapshotToCodeMirrorOffset,
    buildSelection,
    normalizeLegacyLocations,
    normalizeHistoryLocations,
    normalizeCommentLocations,
  }
})
