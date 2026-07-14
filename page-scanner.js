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
    scanDocuments,
  }
})
