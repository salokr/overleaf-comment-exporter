const test = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

const { scanDocuments } = require('../page-scanner')

test('discovers nested lazy documents by ID and preserves duplicate full paths', async t => {
  const fixture = createFixture(`
    <div class="outline-pane">
      <li role="treeitem" aria-label="Outline heading" aria-expanded="false">
        <button id="outline-toggle" aria-label="Expand Outline heading">Outline heading</button>
      </li>
    </div>
    <ul role="tree" class="file-tree">
      <div class="file-tree-folder-list-inner">
        ${documentMarkup('doc-home', 'home.tex')}
        ${folderMarkup('chapters')}
        ${folderMarkup('appendix')}
        ${folderMarkup('already-open', true)}
        <ul role="tree" data-parent-folder-id="already-open">
          <div class="file-tree-folder-list-inner"></div>
        </ul>
      </div>
    </ul>
  `, {
    initialDocumentId: 'doc-home',
    states: {
      'doc-home': legacyView('doc-home', 'home', 'thread-home'),
      'doc-a': legacyView('doc-a', 'alpha', 'thread-a'),
      'doc-b': legacyView('doc-b', 'bravo', 'thread-b'),
    },
    mountFolder(folder, group) {
      const folderId = folder.querySelector('.entity').dataset.fileId
      if (folderId === 'chapters') {
        group.innerHTML = folderMarkup('drafts')
      } else if (folderId === 'drafts') {
        group.innerHTML = documentMarkup('doc-a', 'notes')
      } else if (folderId === 'appendix') {
        group.innerHTML = documentMarkup('doc-b', 'notes')
      }
    },
  })
  t.after(fixture.close)
  let outlineClicks = 0
  const outline = fixture.document.querySelector(
    '.outline-pane li[role="treeitem"]'
  )
  fixture.document
    .querySelector('#outline-toggle')
    .addEventListener('click', () => {
      outlineClicks += 1
      outline.setAttribute(
        'aria-expanded',
        outline.getAttribute('aria-expanded') === 'true'
          ? 'false'
          : 'true'
      )
    })

  const progress = []
  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 80,
    pollIntervalMs: 1,
    folderSettleMs: 0,
    onProgress(update) {
      progress.push(update)
    },
  })

  assert.deepEqual(result.documents, [
    { documentId: 'doc-home', filePath: 'home.tex' },
    { documentId: 'doc-a', filePath: 'chapters/drafts/notes' },
    { documentId: 'doc-b', filePath: 'appendix/notes' },
  ])
  assert.deepEqual(
    result.locations.map(({ threadId, documentId }) => ({
      threadId,
      documentId,
    })),
    [
      { threadId: 'thread-home', documentId: 'doc-home' },
      { threadId: 'thread-a', documentId: 'doc-a' },
      { threadId: 'thread-b', documentId: 'doc-b' },
    ]
  )
  assert.equal(result.issues.length, 0)
  assert.equal(outlineClicks, 0)
  assert.equal(fixture.currentDocumentId(), 'doc-home')
  assert.equal(
    fixture.document
      .querySelector('.entity[data-file-id="chapters"]')
      .closest('li[role="treeitem"]')
      .getAttribute('aria-expanded'),
    'false'
  )
  assert.equal(fixture.document.querySelector('.entity[data-file-id="drafts"]'), null)
  assert.equal(
    fixture.document
      .querySelector('.entity[data-file-id="appendix"]')
      .closest('li[role="treeitem"]')
      .getAttribute('aria-expanded'),
    'false'
  )
  assert.equal(
    fixture.document
      .querySelector('.entity[data-file-id="already-open"]')
      .closest('li[role="treeitem"]')
      .getAttribute('aria-expanded'),
    'true'
  )
  assert.equal(fixture.folderCollapses[0], 'drafts')
  assert.equal(fixture.fileClicks.at(-1), 'doc-home')
  assert.ok(
    fixture.events.lastIndexOf('file:doc-home') >
      fixture.events.findLastIndex(event => event.startsWith('collapse:'))
  )
  const nestedEntity = fixture.document.querySelector(
    '.entity[data-file-id="doc-a"]'
  )
  assert.equal(nestedEntity, null, 'collapsed lazy subtree is unmounted')
  assert.ok(
    progress.some(
      update =>
        update.phase === 'scanning' &&
        update.documentId === 'doc-b' &&
        update.fileName === 'appendix/notes'
    )
  )
})

test('current scope scans only the exact current document ID', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-a', 'same.tex')}
      ${documentMarkup('doc-b', 'same.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-b',
      states: {
        'doc-a': legacyView('doc-a', 'alpha', 'thread-a'),
        'doc-b': legacyView('doc-b', 'bravo', 'thread-b'),
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'current',
    timeoutMs: 50,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.documents, [
    { documentId: 'doc-b', filePath: 'same.tex' },
  ])
  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-b',
  ])
  assert.deepEqual(fixture.fileClicks, ['doc-b'])
  assert.deepEqual(
    new Set(fixture.storeReads),
    new Set([
      'editor.view',
      'editor.open_doc_id',
      'editor.open_doc_name',
    ])
  )
})

test('waits for exact ID and a fresh editor state despite matching breadcrumb text', async t => {
  const fixture = createFixture(
    `<div class="ol-cm-breadcrumbs"><div>target.tex</div></div>
     <ul role="tree" class="file-tree">
       ${documentMarkup('doc-target', 'target.tex')}
       ${documentMarkup('doc-original', 'original.tex')}
     </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-target': legacyView('doc-target', 'target', 'thread-target'),
      },
      transitions: {
        'doc-target': {
          idDelayMs: 8,
          eventDelayMs: 12,
          viewDelayMs: 18,
          intermediateView: unsupportedView('target'),
          rangeReadyDelayMs: 26,
        },
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 100,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-target',
    'thread-original',
  ])
  assert.deepEqual(
    result.locations.map(location => location.documentId),
    ['doc-target', 'doc-original']
  )
})

test('accepts a fresh target state that is ready before the exact open event', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-target', 'target.tex')}
      ${documentMarkup('doc-original', 'original.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-target': legacyView('doc-target', 'target', 'thread-target'),
      },
      transitions: {
        'doc-target': {
          idDelayMs: 2,
          viewDelayMs: 4,
          eventDelayMs: 8,
        },
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 30,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-target',
    'thread-original',
  ])
  assert.equal(result.issues.length, 0)
})

test('rejects stale history state after the open event by exact share-doc ID', async t => {
  const originalView = historyView(
    'doc-original',
    'original',
    'thread-original'
  )
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-target', 'target.tex')}
      ${documentMarkup('doc-original', 'original.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': originalView,
        'doc-target': historyView(
          'doc-target',
          'target',
          'thread-target'
        ),
      },
      transitions: {
        'doc-target': {
          idDelayMs: 2,
          eventDelayMs: 4,
          viewDelayMs: 8,
          intermediateView: historyView(
            'doc-original',
            'original',
            'thread-stale-original'
          ),
          rangeReadyDelayMs: 12,
        },
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 40,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-target',
    'thread-original',
  ])
  assert.deepEqual(
    result.locations.map(location => location.documentId),
    ['doc-target', 'doc-original']
  )
  assert.equal(result.issues.length, 0)
})

test('uses the exact history share-doc marker without an open event', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-target', 'target.tex')}
      ${documentMarkup('doc-original', 'original.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': historyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-target': historyView(
          'doc-target',
          'target',
          'thread-target'
        ),
      },
      transitions: {
        'doc-target': {
          idDelayMs: 2,
          viewDelayMs: 4,
          skipOpenedEvent: true,
        },
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 30,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-target',
    'thread-original',
  ])
  assert.equal(result.issues.length, 0)
})

test('uses a positive polling interval when configured with zero', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-target', 'target.tex')}
      ${documentMarkup('doc-original', 'original.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-target': legacyView('doc-target', 'target', 'thread-target'),
      },
      transitions: {
        'doc-target': {
          idDelayMs: 2,
          eventDelayMs: 4,
          viewDelayMs: 6,
        },
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 40,
    pollIntervalMs: 0,
    folderSettleMs: 0,
  })

  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-target',
    'thread-original',
  ])
  assert.equal(result.issues.length, 0)
})

test('continues scanning after an exact-ID timeout', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-first', 'first.tex')}
      ${documentMarkup('doc-stuck', 'stuck.tex')}
      ${documentMarkup('doc-last', 'last.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-first',
      states: {
        'doc-first': legacyView('doc-first', 'first', 'thread-first'),
        'doc-stuck': legacyView('doc-stuck', 'stuck', 'thread-stuck'),
        'doc-last': legacyView('doc-last', 'last', 'thread-last'),
      },
      transitions: { 'doc-stuck': { neverOpen: true } },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 15,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.documents, [
    { documentId: 'doc-first', filePath: 'first.tex' },
    { documentId: 'doc-last', filePath: 'last.tex' },
  ])
  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-first',
    'thread-last',
  ])
  assert.deepEqual(result.issues, [
    {
      documentId: 'doc-stuck',
      filePath: 'stuck.tex',
      code: 'DOCUMENT_OPEN_TIMEOUT',
      message: 'Timed out waiting for the exact document ID to open.',
    },
  ])
})

test('continues after unsupported per-file ranges and reports unsupported global state', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-unsupported', 'diagram.drawio')}
      ${documentMarkup('doc-good', 'main.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-unsupported',
      states: {
        'doc-unsupported': unsupportedView('not comments'),
        'doc-good': legacyView('doc-good', 'good', 'thread-good'),
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 50,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.documents, [
    { documentId: 'doc-good', filePath: 'main.tex' },
  ])
  assert.deepEqual(result.issues, [
    {
      documentId: 'doc-unsupported',
      filePath: 'diagram.drawio',
      code: 'UNSUPPORTED_RANGE_STATE',
      message: 'Comment range state is unavailable for this document.',
    },
  ])

  const missingStore = new JSDOM('<ul role="tree" class="file-tree"></ul>', {
    url: 'https://www.overleaf.com/project/aaaaaaaaaaaaaaaaaaaaaaaa',
  })
  t.after(() => missingStore.window.close())
  const unsupported = await scanDocuments({ root: missingStore.window })

  assert.deepEqual(unsupported.issues, [
    {
      documentId: null,
      filePath: null,
      code: 'UNSUPPORTED_STATE',
      message: 'Overleaf editor store is unavailable.',
    },
  ])
  assert.deepEqual(unsupported.error, unsupported.issues[0])
})

test('guards throwing store reads and reports a missing editor view', async t => {
  const dom = new JSDOM('<ul role="tree" class="file-tree"></ul>', {
    url: 'https://www.overleaf.com/project/aaaaaaaaaaaaaaaaaaaaaaaa',
  })
  t.after(() => dom.window.close())
  dom.window.overleaf = {
    unstable: {
      store: {
        get(key) {
          if (key === 'editor.view') {
            throw new Error('missing key')
          }
          return null
        },
      },
    },
  }

  const result = await scanDocuments({ root: dom.window })

  assert.deepEqual(result.issues, [
    {
      documentId: null,
      filePath: null,
      code: 'UNSUPPORTED_STATE',
      message: 'Overleaf editor view is unavailable.',
    },
  ])
  assert.deepEqual(result.error, result.issues[0])
})

test('returns an explicit error when no selected document can be extracted', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">${documentMarkup('doc-only', 'only.tex')}</ul>`,
    {
      initialDocumentId: 'doc-only',
      states: { 'doc-only': unsupportedView('only') },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'current',
    timeoutMs: 30,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.documents, [])
  assert.equal(result.error.code, 'NO_DOCUMENTS_EXTRACTED')
  assert.equal(result.error.message, 'No document could be extracted.')
  assert.deepEqual(result.issues.at(-1), result.error)
})

test('restores a nested original before collapsing its scanner-expanded folder', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">${folderMarkup('src')}</ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-last': legacyView('doc-last', 'last', 'thread-last'),
      },
      mountFolder(folder, group) {
        if (folder.querySelector('.entity').dataset.fileId === 'src') {
          group.innerHTML = `${documentMarkup('doc-original', 'original.tex')}
            ${documentMarkup('doc-last', 'last.tex')}`
        }
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 50,
    pollIntervalMs: 1,
    folderSettleMs: 0,
  })

  assert.deepEqual(result.documents, [
    { documentId: 'doc-original', filePath: 'src/original.tex' },
    { documentId: 'doc-last', filePath: 'src/last.tex' },
  ])
  assert.deepEqual(result.issues, [])
  assert.equal(fixture.currentDocumentId(), 'doc-original')
  assert.deepEqual(fixture.fileClicks, [
    'doc-original',
    'doc-last',
    'doc-original',
  ])
  assert.ok(
    fixture.events.lastIndexOf('file:doc-original') <
      fixture.events.indexOf('collapse:src')
  )
  assert.equal(
    fixture.document
      .querySelector('.entity[data-file-id="src"]')
      .closest('li[role="treeitem"]')
      .getAttribute('aria-expanded'),
    'false'
  )
})

test('restores a nested original before folder collapse when extraction throws', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">${folderMarkup('src')}</ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-bad': legacyView('doc-bad', 'short', 'thread-bad', {
          throwOnRangeRead: true,
        }),
      },
      mountFolder(folder, group) {
        if (folder.querySelector('.entity').dataset.fileId === 'src') {
          group.innerHTML = `${documentMarkup('doc-original', 'original.tex')}
            ${documentMarkup('doc-bad', 'bad.tex')}`
        }
      },
    }
  )
  t.after(fixture.close)

  let caught
  try {
    await scanDocuments({
      root: fixture.window,
      scope: 'all',
      timeoutMs: 50,
      pollIntervalMs: 1,
      folderSettleMs: 0,
    })
  } catch (error) {
    caught = error
  }

  assert.match(caught.message, /Selection offsets must form a valid range/)
  assert.equal(
    (caught.scanIssues || []).some(
      issue => issue.code === 'RESTORE_DOCUMENT_NOT_FOUND'
    ),
    false
  )
  assert.equal(fixture.currentDocumentId(), 'doc-original')
  assert.deepEqual(fixture.fileClicks, [
    'doc-original',
    'doc-bad',
    'doc-original',
  ])
  assert.ok(
    fixture.events.lastIndexOf('file:doc-original') <
      fixture.events.indexOf('collapse:src')
  )
  assert.equal(
    fixture.document
      .querySelector('.entity[data-file-id="src"]')
      .closest('li[role="treeitem"]')
      .getAttribute('aria-expanded'),
    'false'
  )
})

test('restores the original document and expanded folders after extraction throws', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-original', 'original.tex')}
      ${folderMarkup('src')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-bad': legacyView('doc-bad', 'short', 'thread-bad', {
          throwOnRangeRead: true,
        }),
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
      },
      mountFolder(folder, group) {
        if (folder.querySelector('.entity').dataset.fileId === 'src') {
          group.innerHTML = documentMarkup('doc-bad', 'bad.tex')
        }
      },
    }
  )
  t.after(fixture.close)

  await assert.rejects(
    scanDocuments({
      root: fixture.window,
      scope: 'all',
      timeoutMs: 50,
      pollIntervalMs: 1,
      folderSettleMs: 0,
    }),
    /Selection offsets must form a valid range/
  )

  assert.equal(fixture.currentDocumentId(), 'doc-original')
  assert.deepEqual(fixture.fileClicks, [
    'doc-original',
    'doc-bad',
    'doc-original',
    'doc-original',
  ])
  assert.equal(
    fixture.document
      .querySelector('.entity[data-file-id="src"]')
      .closest('li[role="treeitem"]')
      .getAttribute('aria-expanded'),
    'false'
  )
  assert.ok(
    fixture.events.indexOf('collapse:src') <
      fixture.events.lastIndexOf('file:doc-original')
  )
})

test('reports restoration failure without discarding successful scan data', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-original', 'original.tex')}
      ${documentMarkup('doc-last', 'last.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-last': legacyView('doc-last', 'last', 'thread-last'),
      },
      transitions: {
        'doc-original': { failAfterClicks: 1 },
      },
    }
  )
  t.after(fixture.close)

  const result = await scanDocuments({
    root: fixture.window,
    scope: 'all',
    timeoutMs: 15,
    pollIntervalMs: 1,
  })

  assert.deepEqual(result.documents, [
    { documentId: 'doc-original', filePath: 'original.tex' },
    { documentId: 'doc-last', filePath: 'last.tex' },
  ])
  assert.deepEqual(result.locations.map(location => location.threadId), [
    'thread-original',
    'thread-last',
  ])
  assert.deepEqual(result.issues, [
    {
      documentId: 'doc-original',
      filePath: 'original.tex',
      code: 'RESTORE_DOCUMENT_TIMEOUT',
      message: 'Timed out restoring the originally open document.',
    },
  ])
})

test('does not hide an extraction error when restoration itself throws', async t => {
  let breakRestoration = null
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-original', 'original.tex')}
      ${documentMarkup('doc-bad', 'bad.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-bad': throwingLegacyView('doc-bad', () =>
          breakRestoration()
        ),
      },
    }
  )
  t.after(fixture.close)
  const querySelectorAll = fixture.document.querySelectorAll
  breakRestoration = () => {
    fixture.document.querySelectorAll = () => {
      throw new Error('restoration infrastructure failed')
    }
    throw new Error('primary extraction failed')
  }

  let caught
  try {
    await scanDocuments({
      root: fixture.window,
      scope: 'all',
      timeoutMs: 30,
      pollIntervalMs: 1,
    })
  } catch (error) {
    caught = error
  } finally {
    fixture.document.querySelectorAll = querySelectorAll
  }

  assert.equal(caught.message, 'primary extraction failed')
  assert.equal(caught.scanIssues.at(-1).code, 'RESTORE_STATE_FAILED')
})

test('rethrows a falsy extraction value exactly', async t => {
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-original', 'original.tex')}
      ${documentMarkup('doc-bad', 'bad.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-bad': throwingLegacyView('doc-bad', () => {
          throw null
        }),
      },
    }
  )
  t.after(fixture.close)

  let didThrow = false
  let caught = Symbol('not thrown')
  try {
    await scanDocuments({
      root: fixture.window,
      scope: 'all',
      timeoutMs: 30,
      pollIntervalMs: 1,
    })
  } catch (error) {
    didThrow = true
    caught = error
  }

  assert.equal(didThrow, true)
  assert.equal(caught, null)
  assert.equal(fixture.currentDocumentId(), 'doc-original')
})

test('preserves a frozen extraction error when restoration adds issues', async t => {
  const primaryError = Object.freeze(new Error('frozen primary error'))
  let breakRestoration = null
  const fixture = createFixture(
    `<ul role="tree" class="file-tree">
      ${documentMarkup('doc-original', 'original.tex')}
      ${documentMarkup('doc-bad', 'bad.tex')}
    </ul>`,
    {
      initialDocumentId: 'doc-original',
      states: {
        'doc-original': legacyView(
          'doc-original',
          'original',
          'thread-original'
        ),
        'doc-bad': throwingLegacyView('doc-bad', () =>
          breakRestoration()
        ),
      },
    }
  )
  t.after(fixture.close)
  const querySelectorAll = fixture.document.querySelectorAll
  breakRestoration = () => {
    fixture.document.querySelectorAll = () => {
      throw new Error('restoration infrastructure failed')
    }
    throw primaryError
  }

  let caught
  try {
    await scanDocuments({
      root: fixture.window,
      scope: 'all',
      timeoutMs: 30,
      pollIntervalMs: 1,
    })
  } catch (error) {
    caught = error
  } finally {
    fixture.document.querySelectorAll = querySelectorAll
  }

  assert.equal(caught, primaryError)
})

function createFixture(html, options) {
  const dom = new JSDOM(html, {
    url: 'https://www.overleaf.com/project/aaaaaaaaaaaaaaaaaaaaaaaa',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const { document } = window
  const states = options.states
  const transitions = options.transitions || {}
  const clicksByDocument = new Map()
  const fileClicks = []
  const folderCollapses = []
  const events = []
  const storeReads = []
  let openDocumentId = options.initialDocumentId
  let openDocumentName = findDocumentName(document, openDocumentId)
  let editorView = states[openDocumentId]

  const store = {
    get(key) {
      storeReads.push(key)
      if (key === 'editor.view') return editorView
      if (key === 'editor.open_doc_id') return openDocumentId
      if (key === 'editor.open_doc_name') return openDocumentName
      throw new Error(`Unexpected store key: ${key}`)
    },
  }
  window.overleaf = { unstable: { store } }

  document.addEventListener('click', event => {
    const folderEntity = event.target.closest(
      '.entity[data-file-type="folder"][data-file-id]'
    )
    if (folderEntity) {
      const folderToggle = event.target.closest('.file-tree-entity-button')
      if (!folderToggle) return
      const folder = folderEntity.closest('li[role="treeitem"]')
      const folderId = folderEntity.dataset.fileId
      const wasExpanded = folder.getAttribute('aria-expanded') === 'true'
      folder.setAttribute('aria-expanded', wasExpanded ? 'false' : 'true')
      folderToggle.setAttribute(
        'aria-label',
        `${wasExpanded ? 'Expand' : 'Collapse'} ${folder.getAttribute('aria-label')}`
      )
      if (wasExpanded) {
        folderCollapses.push(folderId)
        events.push(`collapse:${folderId}`)
        const group = folder.nextElementSibling
        if (group?.matches('ul[role="tree"]')) group.remove()
      } else {
        events.push(`expand:${folderId}`)
        const group = document.createElement('ul')
        group.setAttribute('role', 'tree')
        group.dataset.parentFolderId = folderId
        const inner = document.createElement('div')
        inner.className = 'file-tree-folder-list-inner'
        group.append(inner)
        folder.after(group)
        options.mountFolder?.(folder, inner)
      }
      return
    }

    const file = event.target.closest(
      '.entity[data-file-type="doc"][data-file-id]'
    )
    if (!file) return

    const documentId = file.dataset.fileId
    const clickCount = (clicksByDocument.get(documentId) || 0) + 1
    clicksByDocument.set(documentId, clickCount)
    fileClicks.push(documentId)
    events.push(`file:${documentId}`)
    const transition = transitions[documentId] || {}
    if (
      transition.neverOpen ||
      (transition.failAfterClicks && clickCount > transition.failAfterClicks)
    ) {
      return
    }

    const setId = () => {
      openDocumentId = documentId
      openDocumentName = file
        .closest('li[role="treeitem"]')
        .getAttribute('aria-label')
    }
    const setView = () => {
      editorView = transition.intermediateView || states[documentId]
    }
    const setRangeReady = () => {
      editorView = states[documentId]
    }
    const dispatchOpened = () => {
      window.dispatchEvent(
        new window.CustomEvent('doc:after-opened', {
          detail: { isNewDoc: false, docId: documentId },
        })
      )
    }

    if (transition.idDelayMs) window.setTimeout(setId, transition.idDelayMs)
    else setId()
    if (transition.skipOpenedEvent) {
      // Exact state identity is sufficient; the page event is diagnostic only.
    } else if (transition.eventDelayMs) {
      window.setTimeout(dispatchOpened, transition.eventDelayMs)
    } else {
      dispatchOpened()
    }
    if (transition.viewDelayMs) {
      window.setTimeout(setView, transition.viewDelayMs)
    } else {
      setView()
    }
    if (transition.intermediateView) {
      window.setTimeout(setRangeReady, transition.rangeReadyDelayMs || 0)
    }
  })

  return {
    window,
    document,
    storeReads,
    fileClicks,
    folderCollapses,
    events,
    currentDocumentId: () => openDocumentId,
    close: () => window.close(),
  }
}

function documentMarkup(documentId, name) {
  return `
    <li role="treeitem" aria-label="${name}">
      <div class="entity" data-file-type="doc" data-file-id="${documentId}">
        <div class="entity-name"><div class="file-tree-entity-details">${name}</div></div>
      </div>
    </li>
  `
}

function folderMarkup(folderId, expanded = false) {
  return `
    <li role="treeitem" aria-label="${folderId}" aria-expanded="${expanded}">
      <div class="entity" data-file-type="folder" data-file-id="${folderId}">
        <div class="entity-name">
          <button class="file-tree-entity-button" aria-label="${expanded ? 'Collapse' : 'Expand'} ${folderId}">${folderId}</button>
        </div>
      </div>
    </li>
  `
}

function findDocumentName(document, documentId) {
  return (
    Array.from(
      document.querySelectorAll(
        '.entity[data-file-type="doc"][data-file-id]'
      )
    ).find(element => element.dataset.fileId === documentId)
      ?.closest('li[role="treeitem"]')
      ?.getAttribute('aria-label') || `${documentId}.tex`
  )
}

function legacyView(documentId, content, threadId, options = {}) {
  const start = options.start || 0
  const op = options.throwOnRangeRead
    ? Object.defineProperty({}, 't', {
        get() {
          throw new RangeError(
            'Selection offsets must form a valid range'
          )
        },
      })
    : {
        t: threadId,
        p: start,
        c: content.slice(0, 1),
      }
  return {
    state: {
      doc: { toString: () => content },
      values: [
        {
          ranges: {
            docId: documentId,
            comments: [
              {
                op,
              },
            ],
          },
          threads: {},
        },
      ],
    },
  }
}

function unsupportedView(content) {
  return {
    state: {
      doc: { toString: () => content },
      values: [{ unrelated: true }],
    },
  }
}

function historyView(documentId, content, threadId) {
  const doc =
    typeof content === 'string'
      ? { toString: () => content }
      : content
  return {
    state: {
      doc,
      values: [
        historyShareDocMarker(documentId),
        {
          comments: new Map([
            [
              threadId,
              {
                id: threadId,
                ranges: [{ start: 0, end: 1 }],
              },
            ],
          ]),
          trackedChanges: { asSorted: () => [] },
        },
      ],
    },
  }
}

function historyShareDocMarker(documentId) {
  return {
    otType: 'history-ot',
    name: documentId,
    getText() {},
    submitOp() {},
    snapshot: {
      getComments() {},
      getTrackedChanges() {},
    },
  }
}

function throwingLegacyView(documentId, throwPrimary) {
  return {
    state: {
      doc: { toString: () => 'bad' },
      values: [
        {
          ranges: {
            docId: documentId,
            comments: [
              {
                get op() {
                  return throwPrimary()
                },
              },
            ],
          },
          threads: {},
        },
      ],
    },
  }
}
