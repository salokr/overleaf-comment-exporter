/* Overleaf Comment Exporter — pure page scanner helpers. */

;(function exposeScanner(root, factory) {
  const api = factory(root)

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.__olceScanner = api
  }
})(typeof globalThis === 'object' ? globalThis : this, function createScanner(
  runtimeRoot
) {
  'use strict'

  const DOCUMENT_SELECTOR =
    '.entity[data-file-type="doc"][data-file-id]'
  const COLLAPSED_FOLDER_SELECTOR =
    'li[role="treeitem"][aria-expanded="false"]'

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
      if (!op || op.t == null) {
        continue
      }

      const thread = getThread(resolvedThreads, op.t)
      const resolved = Boolean(comment.resolved || thread?.resolved)
      addSelection(
        locations,
        op.t,
        stateValue.ranges.docId,
        resolved,
        null
      )
      if (!Number.isInteger(op.p) || typeof op.c !== 'string') {
        continue
      }
      const end = op.p + op.c.length
      if (op.p < 0 || end < op.p || end > content.length) {
        continue
      }
      addSelection(
        locations,
        op.t,
        stateValue.ranges.docId,
        resolved,
        buildSelection(content, op.p, end)
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
      if (!comment || comment.id == null) {
        continue
      }

      addSelection(
        locations,
        comment.id,
        documentId,
        Boolean(comment.resolved),
        null
      )
      if (!isIterable(comment.ranges)) continue

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
        if (start < 0 || end < start || end > content.length) {
          continue
        }
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

  function detectProject(root = runtimeRoot) {
    const documentRoot = root?.document
    const pathname = root?.location?.pathname || ''
    const pathMatch = pathname.match(
      /\/project\/([a-f0-9]{24})(?:\/|$)/i
    )
    const metaProjectId = documentRoot
      ?.querySelector('meta[name="ol-project_id"]')
      ?.getAttribute('content')
      ?.trim()
    const projectId = pathMatch?.[1] || metaProjectId || ''
    const projectName =
      documentRoot
        ?.querySelector('meta[name="ol-projectName"]')
        ?.getAttribute('content')
        ?.trim() || documentRoot?.title?.trim() || 'Overleaf project'

    if (!projectId) {
      throw new Error('Unable to determine the Overleaf project ID.')
    }

    return { projectId, projectName }
  }

  function normalizeThreads(rawThreads) {
    if (
      rawThreads == null ||
      typeof rawThreads !== 'object' ||
      Array.isArray(rawThreads)
    ) {
      throw new TypeError(
        'The thread response from /threads must be an object.'
      )
    }

    return Object.entries(rawThreads).map(([threadId, thread]) => {
      if (
        thread == null ||
        typeof thread !== 'object' ||
        Array.isArray(thread) ||
        !Array.isArray(thread.messages)
      ) {
        throw new TypeError(
          `Thread ${threadId} must contain a messages array.`
        )
      }

      const messages = thread.messages.map((message, index) => {
        if (
          message == null ||
          typeof message !== 'object' ||
          Array.isArray(message)
        ) {
          throw new TypeError(
            `Thread ${threadId} message ${index + 1} is invalid.`
          )
        }
        if (
          (typeof message.id !== 'string' &&
            typeof message.id !== 'number') ||
          String(message.id).trim() === ''
        ) {
          throw new TypeError(
            `Thread ${threadId} message ${index + 1} has no stable message ID.`
          )
        }
        if (typeof message.content !== 'string') {
          throw new TypeError(
            `Thread ${threadId} message ${index + 1} has invalid content.`
          )
        }

        const userId = stringValue(
          message.user_id ?? message.user?.id
        )
        return {
          id: String(message.id),
          content: normalizeMessageContent(message.content),
          timestamp: isoTimestamp(message.timestamp),
          userId,
          author: messageAuthor(message.user, userId),
        }
      })

      return {
        threadId,
        resolved: Boolean(thread.resolved),
        resolvedAt: isoTimestamp(thread.resolved_at),
        messages,
      }
    })
  }

  function buildExportModel(options) {
    const threads = Array.isArray(options?.threads)
      ? options.threads
      : []
    const scanResult = options?.scanResult || {}
    const documents = Array.isArray(scanResult.documents)
      ? scanResult.documents
      : []
    const locations = Array.isArray(scanResult.locations)
      ? scanResult.locations
      : []
    const documentById = new Map(
      documents.map(document => [document.documentId, document])
    )
    const threadById = new Map(
      threads.map(thread => [thread.threadId, thread])
    )
    const locationsByThread = new Map()
    const issues = Array.isArray(scanResult.issues)
      ? scanResult.issues.map(issue => ({ ...issue }))
      : []

    for (const location of locations) {
      const threadId = stringValue(location?.threadId)
      if (!threadId) continue

      if (!threadById.has(threadId)) {
        const document = documentById.get(location.documentId)
        issues.push({
          documentId: location.documentId ?? null,
          filePath: document?.filePath ?? null,
          code: 'THREAD_NOT_FOUND',
          message:
            'Source range references a thread absent from /threads.',
          threadId,
        })
        continue
      }

      if (!locationsByThread.has(threadId)) {
        locationsByThread.set(threadId, [])
      }
      locationsByThread.get(threadId).push(location)
    }

    const includedThreads =
      options?.scope === 'current'
        ? threads.filter(thread => locationsByThread.has(thread.threadId))
        : threads
    const records = includedThreads.map(thread => {
      const attached = locationsByThread.get(thread.threadId) || []
      const locatedAttachment = attached.find(location => {
        const document = documentById.get(location.documentId)
        return (
          Boolean(document?.filePath) &&
          Array.isArray(location.selections) &&
          location.selections.length > 0
        )
      })
      const knownAttachment = locatedAttachment || attached[0] || null
      const document = locatedAttachment
        ? documentById.get(locatedAttachment.documentId)
        : null
      const selections = locatedAttachment
        ? locatedAttachment.selections.slice()
        : []
      const firstSelection = selections[0]
      const located = Boolean(document && firstSelection)
      const unlocatedReason = located
        ? ''
        : knownAttachment
          ? 'The source range was detached or deleted.'
          : 'No source range was found in the scanned documents.'

      return {
        threadId: thread.threadId,
        resolved: thread.resolved,
        resolvedAt: thread.resolvedAt,
        status: thread.resolved ? 'resolved' : 'open',
        filePath: located ? document.filePath : null,
        documentId: knownAttachment?.documentId ?? null,
        selections,
        messages: thread.messages.map(message => ({ ...message })),
        unlocatedReason,
        file: located ? document.filePath : '(unlocated)',
        fragment: firstSelection?.selectedText ?? '',
        context: firstSelection
          ? formatCompatibilityContext(firstSelection.context)
          : '',
        position: firstSelection?.offset?.start ?? '',
      }
    })

    records.sort(compareRecords)

    const perFileCounts = new Map()
    for (const record of records) {
      perFileCounts.set(
        record.file,
        (perFileCounts.get(record.file) || 0) + 1
      )
    }
    const perFile = Array.from(perFileCounts, ([file, count]) => ({
      file,
      count,
    }))
    const located = records.filter(record => record.filePath).length
    const resolved = records.filter(record => record.resolved).length
    const summary = {
      filesScanned: documents.length,
      total: records.length,
      located,
      unlocated: records.length - located,
      open: records.length - resolved,
      resolved,
      perFile,
      issues,
      partial: issues.length > 0 || located !== records.length,
    }

    return {
      schemaVersion: 2,
      project: options?.project || 'Overleaf project',
      projectId: options?.projectId || '',
      generated: options?.generated || new Date().toISOString(),
      scope: options?.scope === 'current' ? 'current' : 'all',
      filesScanned: summary.filesScanned,
      totalComments: summary.total,
      locatedComments: summary.located,
      unlocatedComments: summary.unlocated,
      openComments: summary.open,
      resolvedComments: summary.resolved,
      perFile: summary.perFile,
      issues: summary.issues,
      partial: summary.partial,
      summary,
      records,
    }
  }

  function buildMarkdown(model) {
    const lines = [
      `# Overleaf comments — ${model.project}`,
      '',
      `Generated: ${model.generated}`,
      `Scope: ${model.scope}`,
      `Files scanned: ${model.summary.filesScanned}`,
      `Threads: ${model.summary.total} (${model.summary.located} located, ${model.summary.unlocated} unlocated; ${model.summary.open} open, ${model.summary.resolved} resolved)`,
    ]

    if (model.summary.partial) {
      lines.push(
        '',
        `> **Partial export:** ${partialExportReason(model.summary)}`
      )
    }

    const groups = groupRecords(model.records)
    for (const [file, records] of groups) {
      lines.push('', `## ${file}`, '')
      for (const record of records) {
        lines.push(
          `### Thread \`${record.threadId}\` — ${record.status}`,
          ''
        )
        if (record.resolvedAt) {
          lines.push(`Resolved: ${record.resolvedAt}`, '')
        }
        if (!record.filePath) {
          lines.push(`Reason: ${record.unlocatedReason}`, '')
        }

        record.selections.forEach((selection, index) => {
          const label =
            record.selections.length > 1
              ? `Selection ${index + 1}`
              : 'Selection'
          lines.push(
            `#### ${label} — Lines ${selection.start.line}:${selection.start.column}–${selection.end.line}:${selection.end.column}`,
            '',
            'Selected text:',
            fencedBlock(selection.selectedText),
            '',
            'Context:',
            fencedBlock(
              selection.context.lines
                .map(line => `${line.number} | ${line.text}`)
                .join('\n')
            ),
            ''
          )
        })

        lines.push('#### Discussion', '')
        if (record.messages.length === 0) {
          lines.push('_No messages._', '')
        }
        record.messages.forEach((message, index) => {
          const metadata = [message.author, message.timestamp]
            .filter(Boolean)
            .join(' — ')
          lines.push(
            `${index + 1}. ${metadata || 'Unknown reviewer'}`,
            '',
            fencedBlock(message.content),
            ''
          )
        })
      }
    }

    if (model.summary.issues.length > 0) {
      lines.push('', '## Export warnings', '')
      for (const issue of model.summary.issues) {
        const subject = issue.filePath || issue.documentId || 'project'
        lines.push(`- ${issue.code}: ${issue.message} (${subject})`)
      }
    }

    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
  }

  function buildJson(model) {
    return `${JSON.stringify(model, null, 2)}\n`
  }

  function buildCsv(model) {
    const columns = [
      'file',
      'thread_id',
      'resolved',
      'position',
      'fragment',
      'context',
      'author',
      'timestamp',
      'comment',
      'document_id',
      'status',
      'start_line',
      'start_column',
      'end_line',
      'end_column',
      'unlocated_reason',
      'message_id',
    ]
    const rows = [columns.join(',')]

    for (const record of model.records) {
      const selection = record.selections[0]
      const messages = record.messages.length > 0 ? record.messages : [{}]
      for (const message of messages) {
        rows.push(
          [
            record.file,
            record.threadId,
            String(record.resolved),
            record.position,
            record.fragment,
            record.context,
            message.author || '',
            message.timestamp || '',
            message.content || '',
            record.documentId || '',
            record.status,
            selection?.start?.line ?? '',
            selection?.start?.column ?? '',
            selection?.end?.line ?? '',
            selection?.end?.column ?? '',
            record.unlocatedReason,
            message.id || '',
          ]
            .map(csvCell)
            .join(',')
        )
      }
    }

    return `${rows.join('\n')}\n`
  }

  async function scan(options = {}) {
    const root = options.root || runtimeRoot
    const updateProgress = update => {
      const progress = { ...update }
      root.__olceProgress = progress
      publishProgress(options.onProgress, progress)
    }

    try {
      const project = detectProject(root)
      updateProgress({ phase: 'reading', done: false })
      const fetchFn = options.fetch || root?.fetch?.bind(root)
      if (typeof fetchFn !== 'function') {
        throw new Error('The browser fetch API is unavailable.')
      }
      const response = await fetchFn(
        `/project/${project.projectId}/threads`,
        {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        }
      )
      if (!response?.ok) {
        throw new Error(
          `Unable to fetch reviewer threads (HTTP ${response?.status ?? 'unknown'}).`
        )
      }
      const threads = normalizeThreads(await response.json())

      const scanDocumentsFn = options.scanDocumentsFn || scanDocuments
      const scanResult = await scanDocumentsFn({
        root,
        scope: options.scope === 'current' ? 'current' : 'all',
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        folderSettleMs: options.folderSettleMs,
        onProgress(progress) {
          updateProgress({ ...progress, phase: 'scanning', done: false })
        },
      })
      if (scanResult?.error) {
        throw new Error(scanResult.error.message || 'Document scan failed.')
      }

      updateProgress({ phase: 'formatting', done: false })
      const now = typeof options.now === 'function' ? options.now() : new Date()
      const model = buildExportModel({
        project: project.projectName,
        projectId: project.projectId,
        generated: now.toISOString(),
        scope: options.scope === 'current' ? 'current' : 'all',
        threads,
        scanResult,
      })
      const requestedFormats = options.formats || {
        md: true,
        json: true,
        csv: false,
      }
      const outputs = []
      if (requestedFormats.md !== false) {
        outputs.push({
          extension: 'md',
          text: buildMarkdown(model),
          mime: 'text/markdown;charset=utf-8',
        })
      }
      if (requestedFormats.json !== false) {
        outputs.push({
          extension: 'json',
          text: buildJson(model),
          mime: 'application/json;charset=utf-8',
        })
      }
      if (requestedFormats.csv) {
        outputs.push({
          extension: 'csv',
          text: buildCsv(model),
          mime: 'text/csv;charset=utf-8',
        })
      }

      updateProgress({ phase: 'downloading', done: false })
      const download =
        typeof options.download === 'function'
          ? options.download
          : (name, text, mime) => downloadText(root, name, text, mime)
      const baseName = `${safeFilename(project.projectName)}-comments-${dateStamp(now)}`
      for (const output of outputs) {
        download(
          `${baseName}.${output.extension}`,
          output.text,
          output.mime
        )
      }

      const result = {
        ok: true,
        formats: outputs.map(output => output.extension),
        filesScanned: model.summary.filesScanned,
        totalComments: model.summary.total,
        located: model.summary.located,
        unlocated: model.summary.unlocated,
        open: model.summary.open,
        resolved: model.summary.resolved,
        partial: model.summary.partial,
        perFile: model.summary.perFile,
        issues: model.summary.issues,
      }
      updateProgress({ phase: 'done', done: true, ...result })
      return result
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      updateProgress({ phase: 'error', done: true, ...result })
      return result
    }
  }

  async function scanDocuments(options = {}) {
    const root = options.root || runtimeRoot
    const documentRoot = root?.document
    const result = { documents: [], locations: [], issues: [] }
    const store = root?.overleaf?.unstable?.store

    if (!store || typeof store.get !== 'function') {
      return unsupportedResult(
        result,
        'Overleaf editor store is unavailable.'
      )
    }

    const original = readEditorSnapshot(store)
    if (!original.state) {
      return unsupportedResult(
        result,
        'Overleaf editor view is unavailable.'
      )
    }
    if (original.documentId == null) {
      return unsupportedResult(
        result,
        'Overleaf open document ID is unavailable.'
      )
    }
    if (!documentRoot?.querySelectorAll) {
      return unsupportedResult(
        result,
        'Overleaf document tree is unavailable.'
      )
    }

    const timeoutMs = finiteOption(options.timeoutMs, 8000)
    const pollIntervalMs = Math.max(
      1,
      finiteOption(options.pollIntervalMs, 50)
    )
    const folderSettleMs = finiteOption(options.folderSettleMs, 50)
    const expandedFolders = []
    let discoveredDocuments = []
    let didThrow = false
    let primaryError

    publishProgress(options.onProgress, {
      phase: 'discovering',
      fileIndex: 0,
      fileTotal: 0,
      fileName: original.documentName || '',
    })

    try {
      const expansion = await expandCollapsedFolders(documentRoot, {
        root,
        settleMs: folderSettleMs,
      })
      expandedFolders.push(...expansion.folders)
      result.issues.push(...expansion.issues)

      const discovery = discoverDocuments(documentRoot)
      discoveredDocuments = discovery.documents
      result.issues.push(...discovery.issues)

      const selectedDocuments =
        options.scope === 'all'
          ? discoveredDocuments
          : discoveredDocuments.filter(
              document => document.documentId === original.documentId
            )

      if (
        options.scope !== 'all' &&
        selectedDocuments.length === 0
      ) {
        result.issues.push(
          makeIssue(
            'CURRENT_DOCUMENT_NOT_FOUND',
            'The currently open document is not present in the editable document tree.',
            {
              documentId: original.documentId,
              filePath: original.documentName || null,
            }
          )
        )
      }

      for (let index = 0; index < selectedDocuments.length; index += 1) {
        const document = selectedDocuments[index]
        publishProgress(options.onProgress, {
          phase: 'scanning',
          fileIndex: index + 1,
          fileTotal: selectedDocuments.length,
          fileName: document.filePath,
          documentId: document.documentId,
          filePath: document.filePath,
        })

        const beforeOpen = readEditorSnapshot(store)
        clickDocumentTreeitem(document.entity)

        const opened = await waitForExactDocumentId(
          store,
          document.documentId,
          timeoutMs,
          pollIntervalMs,
          root
        )
        if (!opened) {
          result.issues.push(
            makeIssue(
              'DOCUMENT_OPEN_TIMEOUT',
              'Timed out waiting for the exact document ID to open.',
              document
            )
          )
          continue
        }

        const editor = await waitForEditorState(
          store,
          document,
          beforeOpen,
          beforeOpen.documentId === document.documentId,
          timeoutMs,
          pollIntervalMs,
          root
        )
        if (!editor) {
          result.issues.push(
            makeIssue(
              'EDITOR_STATE_TIMEOUT',
              'Timed out waiting for the editor state to match the document.',
              document
            )
          )
          continue
        }

        if (!editor.supported) {
          result.issues.push(
            makeIssue(
              'UNSUPPORTED_RANGE_STATE',
              'Comment range state is unavailable for this document.',
              document
            )
          )
          continue
        }

        const content = codeMirrorContent(editor.state)
        if (content == null) {
          result.issues.push(
            makeIssue(
              'UNSUPPORTED_RANGE_STATE',
              'Comment range state is unavailable for this document.',
              document
            )
          )
          continue
        }

        const locations = normalizeCommentLocations(
          editor.state,
          document.documentId,
          content
        )
        result.documents.push(publicDocument(document))
        result.locations.push(...locations)
      }

      if (result.documents.length === 0) {
        result.error = makeIssue(
          'NO_DOCUMENTS_EXTRACTED',
          'No document could be extracted.'
        )
        result.issues.push(result.error)
      }
    } catch (error) {
      didThrow = true
      primaryError = error
    } finally {
      publishProgress(options.onProgress, {
        phase: 'restoring',
        fileIndex: result.documents.length,
        fileTotal: result.documents.length,
        fileName: original.documentName || '',
        documentId: original.documentId,
      })

      let restorationIssues
      try {
        restorationIssues = await restoreEditorState({
          root,
          store,
          documentRoot,
          original,
          documents: discoveredDocuments,
          expandedFolders,
          timeoutMs,
          pollIntervalMs,
          folderSettleMs,
        })
      } catch (_) {
        restorationIssues = [
          makeIssue(
            'RESTORE_STATE_FAILED',
            'Editor restoration failed unexpectedly.'
          ),
        ]
      }
      result.issues.push(...restorationIssues)
    }

    if (didThrow) {
      if (result.issues.length > 0) {
        attachScanIssues(primaryError, result.issues)
      }
      throw primaryError
    }

    return result
  }

  async function expandCollapsedFolders(documentRoot, options) {
    const folders = []
    const issues = []
    const processedIds = new Set()
    const processedElements = new WeakSet()

    while (true) {
      const wave = Array.from(
        documentRoot.querySelectorAll(COLLAPSED_FOLDER_SELECTOR)
      ).filter(folder => {
        const folderEntity = folder.querySelector(
          '.entity[data-file-type="folder"][data-file-id]'
        )
        if (
          !folderEntity ||
          folderEntity.closest('li[role="treeitem"]') !== folder
        ) {
          return false
        }
        const folderId = folderIdentity(folder)
        return folderId
          ? !processedIds.has(folderId)
          : !processedElements.has(folder)
      })

      if (wave.length === 0) {
        break
      }

      for (const folder of wave) {
        const folderId = folderIdentity(folder)
        if (folderId) processedIds.add(folderId)
        else processedElements.add(folder)

        const record = {
          folderId,
          element: folder,
          wasExpanded: false,
        }
        folders.push(record)

        const toggle = folderToggle(folder)
        if (!toggle) {
          issues.push(
            makeIssue(
              'FOLDER_EXPANSION_FAILED',
              'A collapsed folder could not be expanded.'
            )
          )
          continue
        }

        try {
          toggle.click()
        } catch (_) {
          issues.push(
            makeIssue(
              'FOLDER_EXPANSION_FAILED',
              'A collapsed folder could not be expanded.'
            )
          )
        }
      }

      await delay(options.settleMs, options.root)
    }

    return { folders, issues }
  }

  function discoverDocuments(documentRoot) {
    const documents = []
    const issues = []
    const seenIds = new Set()

    for (const entity of documentRoot.querySelectorAll(
      DOCUMENT_SELECTOR
    )) {
      const documentId = entity.getAttribute('data-file-id')
      if (!documentId || seenIds.has(documentId)) {
        continue
      }
      seenIds.add(documentId)

      const treeitem = entity.closest('li[role="treeitem"]')
      const name = cleanAriaLabel(
        treeitem?.getAttribute('aria-label')
      )
      if (!treeitem || !name) {
        issues.push(
          makeIssue(
            'DOCUMENT_PATH_UNAVAILABLE',
            'An editable document does not expose an accessible name.',
            { documentId, filePath: null }
          )
        )
        continue
      }

      const folderNames = semanticFolderAncestors(treeitem)
        .map(folder =>
          cleanAriaLabel(folder.getAttribute('aria-label'))
        )
        .filter(Boolean)

      documents.push({
        documentId,
        filePath: [...folderNames.reverse(), name].join('/'),
        name,
        entity,
        treeitem,
      })
    }

    return { documents, issues }
  }

  async function waitForExactDocumentId(
    store,
    documentId,
    timeoutMs,
    pollIntervalMs,
    root
  ) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (safeStoreGet(store, 'editor.open_doc_id') === documentId) {
        return true
      }
      if (Date.now() >= deadline) {
        return false
      }
      await delay(pollIntervalMs, root)
    }
  }

  async function waitForEditorState(
    store,
    document,
    baseline,
    wasAlreadyOpen,
    timeoutMs,
    pollIntervalMs,
    root
  ) {
    const deadline = Date.now() + timeoutMs
    let unsupportedEditor = null

    while (true) {
      const current = readEditorSnapshot(store)
      if (
        current.documentId === document.documentId &&
        current.documentName === document.name &&
        current.state?.doc &&
        typeof current.state.doc.toString === 'function'
      ) {
        const fresh =
          wasAlreadyOpen ||
          current.view !== baseline.view ||
          current.state !== baseline.state
        if (fresh) {
          const stateIdentity = identifyCommentState(
            current.state.values
          )
          if (
            stateIdentity.supported &&
            stateIdentity.documentId === document.documentId
          ) {
            return { state: current.state, supported: true }
          }

          const unsupportedHistoryState =
            stateIdentity.model === 'history' &&
            (stateIdentity.documentId == null ||
              stateIdentity.documentId === document.documentId)
          if (
            unsupportedHistoryState ||
            stateIdentity.model == null
          ) {
            unsupportedEditor = {
              state: current.state,
              supported: false,
            }
          }
        }
      }
      if (Date.now() >= deadline) {
        return unsupportedEditor
      }
      await delay(pollIntervalMs, root)
    }
  }

  async function restoreEditorState(options) {
    const issues = []
    const originalDocument = options.documents.find(
      document => document.documentId === options.original.documentId
    )
    const issueDocument =
      originalDocument || {
        documentId: options.original.documentId,
        filePath: options.original.documentName || null,
      }
    const mountedOriginal = originalDocument
      ? resolveDocumentEntity(
          options.documentRoot,
          options.original.documentId
        )
      : null
    let foundOriginal = Boolean(mountedOriginal)
    let documentRestored =
      safeStoreGet(options.store, 'editor.open_doc_id') ===
      options.original.documentId

    if (!documentRestored && mountedOriginal) {
      documentRestored = await reopenDocument(
        options,
        originalDocument,
        mountedOriginal
      )
    }

    let folderSelectionChanged = false
    const folders = options.expandedFolders.slice().reverse()
    for (const record of folders) {
      const folder = resolveFolder(options.documentRoot, record)
      if (!folder || folder.getAttribute('aria-expanded') !== 'true') {
        continue
      }

      const toggle = folderToggle(folder)
      if (!toggle) {
        issues.push(
          makeIssue(
            'FOLDER_RESTORE_FAILED',
            'A folder expanded during scanning could not be collapsed.'
          )
        )
        continue
      }

      try {
        folderSelectionChanged = true
        toggle.click()
        await delay(options.folderSettleMs, options.root)
        if (folder.getAttribute('aria-expanded') === 'true') {
          issues.push(
            makeIssue(
              'FOLDER_RESTORE_FAILED',
              'A folder expanded during scanning could not be collapsed.'
            )
          )
        }
      } catch (_) {
        issues.push(
          makeIssue(
            'FOLDER_RESTORE_FAILED',
            'A folder expanded during scanning could not be collapsed.'
          )
        )
      }
    }

    if (
      safeStoreGet(options.store, 'editor.open_doc_id') !==
      options.original.documentId
    ) {
      documentRestored = false
    }

    const liveOriginal = originalDocument
      ? resolveDocumentEntity(
          options.documentRoot,
          options.original.documentId
        )
      : null
    foundOriginal = foundOriginal || Boolean(liveOriginal)

    if (
      liveOriginal &&
      (folderSelectionChanged || !documentRestored)
    ) {
      documentRestored = await reopenDocument(
        options,
        originalDocument,
        liveOriginal
      )
    }

    if (
      safeStoreGet(options.store, 'editor.open_doc_id') !==
      options.original.documentId ||
      !documentRestored
    ) {
      issues.push(
        foundOriginal
          ? makeIssue(
              'RESTORE_DOCUMENT_TIMEOUT',
              'Timed out restoring the originally open document.',
              issueDocument
            )
          : makeIssue(
              'RESTORE_DOCUMENT_NOT_FOUND',
              'The originally open document could not be found for restoration.',
              issueDocument
            )
      )
    }

    return issues
  }

  async function reopenDocument(options, document, entity) {
    const restoredDocument = {
      ...document,
      entity,
      treeitem: entity.closest('li[role="treeitem"]'),
    }
    const beforeRestore = readEditorSnapshot(options.store)

    try {
      clickDocumentTreeitem(restoredDocument.entity)
      const idRestored = await waitForExactDocumentId(
        options.store,
        restoredDocument.documentId,
        options.timeoutMs,
        options.pollIntervalMs,
        options.root
      )
      const stateRestored =
        idRestored
          ? await waitForEditorState(
              options.store,
              restoredDocument,
              beforeRestore,
              beforeRestore.documentId === restoredDocument.documentId,
              options.timeoutMs,
              options.pollIntervalMs,
              options.root
            )
          : null

      return Boolean(idRestored && stateRestored)
    } catch (_) {
      return false
    }
  }

  function readEditorSnapshot(store) {
    const view = safeStoreGet(store, 'editor.view')
    return {
      view,
      state: view?.state,
      documentId: safeStoreGet(store, 'editor.open_doc_id'),
      documentName: safeStoreGet(store, 'editor.open_doc_name'),
    }
  }

  function safeStoreGet(store, key) {
    try {
      return store.get(key)
    } catch (_) {
      return undefined
    }
  }

  function identifyCommentState(stateValues) {
    const legacyState = findLegacyStateValue(stateValues)
    if (legacyState) {
      return {
        model: 'legacy',
        supported: true,
        documentId: legacyState.ranges.docId,
      }
    }

    const historyState = findHistoryStateValue(stateValues)
    const historyDocument = findHistoryDocumentValue(stateValues)
    if (historyState || historyDocument) {
      return {
        model: 'history',
        supported: Boolean(historyState && historyDocument),
        documentId: historyDocument?.name ?? null,
      }
    }

    return { model: null, supported: false, documentId: null }
  }

  function codeMirrorContent(state) {
    try {
      return state?.doc && typeof state.doc.toString === 'function'
        ? state.doc.toString()
        : null
    } catch (_) {
      return null
    }
  }

  function clickDocumentTreeitem(entity) {
    const buttons = Array.from(entity.querySelectorAll?.('button') || [])
      .filter(button => button.closest(DOCUMENT_SELECTOR) === entity)
    const target =
      buttons.find(button =>
        button.matches(
          '.entity-name-button, [data-testid*="entity-name"], [data-testid*="file-name"]'
        )
      ) ||
      buttons.find(button => !button.matches('[aria-haspopup="true"]')) ||
      entity

    target.scrollIntoView?.({ block: 'center' })
    target.click()
  }

  function folderToggle(folder) {
    const buttons = Array.from(folder.querySelectorAll('button')).filter(
      button =>
        button.closest('li[role="treeitem"]') === folder
    )

    return (
      buttons.find(button =>
        /^(expand|collapse)\b/i.test(
          button.getAttribute('aria-label') || ''
        )
      ) ||
      buttons.find(button =>
        button.matches(
          '.file-tree-entity-button, [aria-expanded], [data-testid*="expand"], [data-testid*="collapse"], [class*="expand"], [class*="collapse"], [class*="toggle"], .entity-name-button'
        )
      ) ||
      buttons[0] ||
      null
    )
  }

  function resolveFolder(documentRoot, record) {
    if (record.folderId) {
      return (
        Array.from(
          documentRoot.querySelectorAll('li[role="treeitem"]')
        ).find(folder => folderIdentity(folder) === record.folderId) ||
        null
      )
    }
    return record.element?.isConnected ? record.element : null
  }

  function resolveDocumentEntity(documentRoot, documentId) {
    return (
      Array.from(documentRoot.querySelectorAll(DOCUMENT_SELECTOR)).find(
        entity =>
          entity.getAttribute('data-file-id') === documentId
      ) || null
    )
  }

  function folderIdentity(folder) {
    return (
      folder.getAttribute('data-folder-id') ||
      folder.getAttribute('data-file-id') ||
      folder.getAttribute('data-id') ||
      folder
        .querySelector(
          '.entity[data-file-type="folder"][data-file-id]'
        )
        ?.getAttribute('data-file-id') ||
      null
    )
  }

  function semanticFolderAncestors(treeitem) {
    const folders = []
    let current = treeitem

    while (current) {
      const containingTree = current.parentElement?.closest(
        'ul[role="tree"]'
      )
      if (!containingTree) {
        break
      }

      let folder = containingTree.previousElementSibling
      if (
        !folder?.matches('li[role="treeitem"]') ||
        !folderIdentity(folder)
      ) {
        folder = containingTree.parentElement?.closest(
          'li[role="treeitem"]'
        )
      }
      if (!folder || !folderIdentity(folder) || folders.includes(folder)) {
        break
      }

      folders.push(folder)
      current = folder
    }

    return folders
  }

  function cleanAriaLabel(value) {
    return typeof value === 'string' ? value.trim() : ''
  }

  function finiteOption(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }

  function publicDocument(document) {
    return {
      documentId: document.documentId,
      filePath: document.filePath,
    }
  }

  function makeIssue(code, message, document = null) {
    return {
      documentId: document?.documentId ?? null,
      filePath: document?.filePath ?? null,
      code,
      message,
    }
  }

  function unsupportedResult(result, message) {
    result.error = makeIssue('UNSUPPORTED_STATE', message)
    result.issues.push(result.error)
    return result
  }

  function publishProgress(callback, update) {
    if (typeof callback !== 'function') {
      return
    }
    try {
      callback(update)
    } catch (_) {
      // Progress reporting must not interrupt document extraction.
    }
  }

  function attachScanIssues(thrownValue, issues) {
    if (
      thrownValue == null ||
      (typeof thrownValue !== 'object' &&
        typeof thrownValue !== 'function')
    ) {
      return
    }

    try {
      if (
        !Object.isExtensible(thrownValue) &&
        !Object.prototype.hasOwnProperty.call(
          thrownValue,
          'scanIssues'
        )
      ) {
        return
      }
      thrownValue.scanIssues = issues.slice()
    } catch (_) {
      // The original thrown value remains authoritative.
    }
  }

  function delay(milliseconds, root) {
    if (milliseconds === 0) {
      return Promise.resolve()
    }
    const schedule =
      typeof root?.setTimeout === 'function'
        ? root.setTimeout.bind(root)
        : setTimeout
    return new Promise(resolve => schedule(resolve, milliseconds))
  }

  function stringValue(value) {
    return value == null ? '' : String(value)
  }

  function normalizeMessageContent(content) {
    return content
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map(line => line.replace(/[\t ]+$/g, ''))
      .join('\n')
      .replace(/\n+$/g, '')
  }

  function isoTimestamp(value) {
    if (value == null || value === '') return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }

  function messageAuthor(user, userId) {
    if (user && typeof user === 'object') {
      const name = stringValue(user.name).trim()
      if (name) return name
      const fullName = [user.first_name, user.last_name]
        .map(value => stringValue(value).trim())
        .filter(Boolean)
        .join(' ')
      if (fullName) return fullName
      const email = stringValue(user.email).trim()
      if (email) return email
    }
    return userId
  }

  function formatCompatibilityContext(context) {
    return Array.isArray(context?.lines)
      ? context.lines
          .map(line => `${line.number}: ${line.text}`)
          .join('\n')
      : ''
  }

  function compareRecords(left, right) {
    if (Boolean(left.filePath) !== Boolean(right.filePath)) {
      return left.filePath ? -1 : 1
    }
    if (left.file !== right.file) {
      return left.file.localeCompare(right.file)
    }
    const leftPosition =
      typeof left.position === 'number'
        ? left.position
        : Number.POSITIVE_INFINITY
    const rightPosition =
      typeof right.position === 'number'
        ? right.position
        : Number.POSITIVE_INFINITY
    return (
      leftPosition - rightPosition ||
      left.threadId.localeCompare(right.threadId)
    )
  }

  function groupRecords(records) {
    const groups = new Map()
    for (const record of records) {
      const group = record.filePath || 'Unlocated'
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(record)
    }
    return groups
  }

  function partialExportReason(summary) {
    const parts = []
    if (summary.unlocated > 0) {
      parts.push(
        `${summary.unlocated} thread${summary.unlocated === 1 ? '' : 's'} could not be linked to source text`
      )
    }
    if (summary.issues.length > 0) {
      parts.push(
        `${summary.issues.length} scan warning${summary.issues.length === 1 ? '' : 's'} occurred`
      )
    }
    return `${parts.join('; ') || 'the scan was incomplete'}.`
  }

  function fencedBlock(content) {
    const text = stringValue(content)
    const runs = text.match(/`+/g) || []
    const longest = runs.reduce(
      (length, run) => Math.max(length, run.length),
      0
    )
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${fence}\n${text}\n${fence}`
  }

  function csvCell(value) {
    return `"${stringValue(value).replace(/"/g, '""')}"`
  }

  function safeFilename(value) {
    const safe = stringValue(value)
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
    return safe || 'overleaf-project'
  }

  function dateStamp(date) {
    return date.toISOString().slice(0, 10)
  }

  function downloadText(root, name, text, mime) {
    if (
      typeof root?.Blob !== 'function' ||
      typeof root?.URL?.createObjectURL !== 'function' ||
      !root?.document?.createElement
    ) {
      throw new Error('Browser download APIs are unavailable.')
    }
    const url = root.URL.createObjectURL(
      new root.Blob([text], { type: mime })
    )
    const link = root.document.createElement('a')
    link.href = url
    link.download = name
    link.hidden = true
    root.document.body?.appendChild(link)
    link.click()
    link.remove()
    root.URL.revokeObjectURL(url)
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

    if (selection) {
      location.selections.push(selection)
    }
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

  function findHistoryDocumentValue(stateValues) {
    return toArray(stateValues).find(
      value =>
        value?.otType === 'history-ot' &&
        typeof value?.name === 'string' &&
        value.name.length > 0 &&
        typeof value?.getText === 'function' &&
        typeof value?.submitOp === 'function' &&
        typeof value?.snapshot?.getComments === 'function' &&
        typeof value?.snapshot?.getTrackedChanges === 'function'
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
    detectProject,
    normalizeThreads,
    buildExportModel,
    buildMarkdown,
    buildJson,
    buildCsv,
    scan,
    scanDocuments,
  }
})
