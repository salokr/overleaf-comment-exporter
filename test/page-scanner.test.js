const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  snapshotToCodeMirrorOffset,
  buildSelection,
  normalizeLegacyLocations,
  normalizeHistoryLocations,
  normalizeCommentLocations,
} = require('../page-scanner')

test('buildSelection returns exact multiline coordinates and two-line context', () => {
  const content = [
    'zero',
    'one 🙂',
    'second line',
    'third line',
    'four',
    'five',
    'six',
  ].join('\n')
  const start = content.indexOf('cond')
  const end = content.indexOf(' line', content.indexOf('third'))

  assert.deepEqual(buildSelection(content, start, end), {
    offset: { start, end },
    start: { line: 3, column: 3 },
    end: { line: 4, column: 6 },
    selectedText: 'cond line\nthird',
    context: {
      startLine: 1,
      endLine: 6,
      lines: [
        { number: 1, text: 'zero' },
        { number: 2, text: 'one 🙂' },
        { number: 3, text: 'second line' },
        { number: 4, text: 'third line' },
        { number: 5, text: 'four' },
        { number: 6, text: 'five' },
      ],
    },
  })
})

test('buildSelection clamps context at the beginning and end of a file', () => {
  const content = ['alpha', 'beta', 'gamma', 'delta', 'omega'].join('\n')

  const first = buildSelection(content, 0, 5)
  assert.deepEqual(first.context, {
    startLine: 1,
    endLine: 3,
    lines: [
      { number: 1, text: 'alpha' },
      { number: 2, text: 'beta' },
      { number: 3, text: 'gamma' },
    ],
  })

  const start = content.indexOf('omega')
  const last = buildSelection(content, start, content.length)
  assert.deepEqual(last.context, {
    startLine: 3,
    endLine: 5,
    lines: [
      { number: 3, text: 'gamma' },
      { number: 4, text: 'delta' },
      { number: 5, text: 'omega' },
    ],
  })
})

test('normalizeLegacyLocations keeps duplicate text distinct by thread ID', () => {
  const content = 'same and same'
  const values = [
    { unrelated: true },
    {
      ranges: {
        docId: 'doc-legacy',
        comments: [
          {
            id: 'range-a',
            op: { t: 'thread-a', p: 0, c: 'same' },
          },
          {
            id: 'range-b',
            op: { t: 'thread-b', p: 9, c: 'same' },
          },
        ],
      },
      threads: {},
    },
  ]

  const locations = normalizeLegacyLocations(values, 'ignored-doc-id', content)

  assert.deepEqual(
    locations.map(location => ({
      threadId: location.threadId,
      documentId: location.documentId,
      selectedText: location.selections[0].selectedText,
      offset: location.selections[0].offset,
    })),
    [
      {
        threadId: 'thread-a',
        documentId: 'doc-legacy',
        selectedText: 'same',
        offset: { start: 0, end: 4 },
      },
      {
        threadId: 'thread-b',
        documentId: 'doc-legacy',
        selectedText: 'same',
        offset: { start: 9, end: 13 },
      },
    ]
  )
})

test('normalizeLegacyLocations reads resolved status from a range or thread', () => {
  const content = 'first second third'
  const values = [
    {
      ranges: {
        docId: 'doc-legacy',
        comments: [
          {
            op: { t: 'range-resolved', p: 0, c: 'first' },
            resolved: true,
          },
          {
            op: { t: 'thread-resolved', p: 6, c: 'second' },
          },
          {
            op: { t: 'open-thread', p: 13, c: 'third' },
          },
        ],
      },
      threads: {
        'thread-resolved': { resolved: true },
        'open-thread': { resolved: false },
      },
    },
  ]

  const locations = normalizeLegacyLocations(values, 'ignored-doc-id', content)

  assert.deepEqual(
    locations.map(({ threadId, resolved }) => ({ threadId, resolved })),
    [
      { threadId: 'range-resolved', resolved: true },
      { threadId: 'thread-resolved', resolved: true },
      { threadId: 'open-thread', resolved: false },
    ]
  )
})

test('snapshotToCodeMirrorOffset maps positions around one tracked deletion', () => {
  const trackedChanges = [trackedDelete(4, 3)]

  assert.equal(snapshotToCodeMirrorOffset(2, trackedChanges), 2)
  assert.equal(snapshotToCodeMirrorOffset(4, trackedChanges), 4)
  assert.equal(snapshotToCodeMirrorOffset(5, trackedChanges), 4)
  assert.equal(snapshotToCodeMirrorOffset(6, trackedChanges), 4)
  assert.equal(snapshotToCodeMirrorOffset(7, trackedChanges), 4)
  assert.equal(snapshotToCodeMirrorOffset(9, trackedChanges), 6)
})

test('snapshotToCodeMirrorOffset subtracts cumulative tracked deletions', () => {
  const trackedChanges = [
    trackedDelete(7, 3),
    trackedInsert(4, 1),
    trackedDelete(2, 2),
  ]

  assert.equal(snapshotToCodeMirrorOffset(0, trackedChanges), 0)
  assert.equal(snapshotToCodeMirrorOffset(3, trackedChanges), 2)
  assert.equal(snapshotToCodeMirrorOffset(5, trackedChanges), 3)
  assert.equal(snapshotToCodeMirrorOffset(7, trackedChanges), 5)
  assert.equal(snapshotToCodeMirrorOffset(9, trackedChanges), 5)
  assert.equal(snapshotToCodeMirrorOffset(10, trackedChanges), 5)
  assert.equal(snapshotToCodeMirrorOffset(12, trackedChanges), 7)
})

test('normalizeHistoryLocations converts every split snapshot range', () => {
  const content = 'AABBccDD'
  const historyValue = {
    comments: new Set([
      {
        id: 'history-thread',
        resolved: false,
        ranges: [
          { pos: 0, length: 2 },
          { pos: 6, end: 8 },
        ],
      },
    ]),
    trackedChanges: {
      asSorted() {
        return [trackedDelete(2, 2)]
      },
    },
  }

  const locations = normalizeHistoryLocations(
    [{ unrelated: true }, historyValue],
    'doc-history',
    content
  )

  assert.equal(locations.length, 1)
  assert.deepEqual(locations[0], {
    threadId: 'history-thread',
    documentId: 'doc-history',
    resolved: false,
    selections: [
      buildSelection(content, 0, 2),
      buildSelection(content, 4, 6),
    ],
  })
})

test('normalizeHistoryLocations preserves resolved status', () => {
  const values = [
    {
      comments: new Map([
        [
          'resolved-thread',
          {
            id: 'resolved-thread',
            resolved: true,
            ranges: [{ pos: 0, length: 4 }],
          },
        ],
      ]).values(),
      trackedChanges: { asSorted: () => [] },
    },
  ]

  const locations = normalizeHistoryLocations(values, 'doc-history', 'text')

  assert.equal(locations[0].resolved, true)
})

test('normalizeCommentLocations detects legacy before history state values', () => {
  const content = 'legacy history'
  const state = {
    values: [
      {
        comments: [
          {
            id: 'history-thread',
            resolved: false,
            ranges: [{ pos: 7, length: 7 }],
          },
        ],
        trackedChanges: { asSorted: () => [] },
      },
      {
        ranges: {
          docId: 'legacy-doc',
          comments: [
            { op: { t: 'legacy-thread', p: 0, c: 'legacy' } },
          ],
        },
      },
    ],
  }

  assert.deepEqual(
    normalizeCommentLocations(state, 'history-doc', content).map(
      ({ threadId, documentId }) => ({ threadId, documentId })
    ),
    [{ threadId: 'legacy-thread', documentId: 'legacy-doc' }]
  )
})

test('normalizeCommentLocations falls back to history state values', () => {
  const state = {
    values: [
      { unrelated: true },
      {
        comments: [
          {
            id: 'history-thread',
            resolved: false,
            ranges: [{ pos: 0, length: 4 }],
          },
        ],
        trackedChanges: { asSorted: () => [] },
      },
    ],
  }

  assert.deepEqual(
    normalizeCommentLocations(state, 'history-doc', 'text').map(
      ({ threadId, documentId }) => ({ threadId, documentId })
    ),
    [{ threadId: 'history-thread', documentId: 'history-doc' }]
  )
})

test('MAIN-world evaluation exposes the pure API on a temporary global', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'page-scanner.js'),
    'utf8'
  )
  const context = { globalThis: {} }

  vm.runInNewContext(source, context)

  assert.deepEqual(
    Object.keys(context.globalThis.__olceScanner).sort(),
    [
      'buildSelection',
      'normalizeCommentLocations',
      'normalizeHistoryLocations',
      'normalizeLegacyLocations',
      'scanDocuments',
      'snapshotToCodeMirrorOffset',
    ]
  )
})

function trackedDelete(pos, length) {
  return {
    tracking: { type: 'delete' },
    range: { pos, length, end: pos + length },
  }
}

function trackedInsert(pos, length) {
  return {
    tracking: { type: 'insert' },
    range: { pos, length, end: pos + length },
  }
}
