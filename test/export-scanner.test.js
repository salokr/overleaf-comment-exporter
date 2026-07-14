const test = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

const {
  buildSelection,
  detectProject,
  normalizeThreads,
  buildExportModel,
  buildMarkdown,
  buildJson,
  buildCsv,
  scan,
} = require('../page-scanner')

test('detectProject reads exact Overleaf path and metadata', () => {
  const dom = new JSDOM(
    '<meta name="ol-projectName" content="Reviewer Paper">',
    {
      url: 'https://www.overleaf.com/project/aaaaaaaaaaaaaaaaaaaaaaaa',
    }
  )
  assert.deepEqual(detectProject(dom.window), {
    projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    projectName: 'Reviewer Paper',
  })
  dom.window.close()

  const fallback = new JSDOM(
    '<meta name="ol-project_id" content="bbbbbbbbbbbbbbbbbbbbbbbb">',
    { url: 'https://www.overleaf.com/read/example' }
  )
  fallback.window.document.title = 'Fallback Project'
  assert.deepEqual(detectProject(fallback.window), {
    projectId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    projectName: 'Fallback Project',
  })
  fallback.window.close()

  const invalidPath = new JSDOM(
    '<meta name="ol-project_id" content="cccccccccccccccccccccccc">',
    { url: 'https://www.overleaf.com/project/not-an-id' }
  )
  assert.equal(
    detectProject(invalidPath.window).projectId,
    'cccccccccccccccccccccccc'
  )
  invalidPath.window.close()
})

test('normalizeThreads preserves stable messages, multiline content, authors, and status', () => {
  const normalized = normalizeThreads({
    'thread-open': {
      messages: [
        {
          id: 'message-1',
          content: 'First line  \r\n  indented\u00a0line\t\n',
          timestamp: 1710000000000,
          user_id: 'user-1',
          user: { name: 'Reviewer One', email: 'ignored@example.com' },
        },
        {
          id: 'message-2',
          content: 'Reply\nwith  internal   spacing',
          timestamp: '2024-03-10T12:30:00Z',
          user_id: 'user-2',
          user: {
            first_name: 'Second',
            last_name: 'Reviewer',
            email: 'second@example.com',
          },
        },
      ],
    },
    'thread-resolved': {
      resolved: true,
      resolved_at: '2024-04-01T01:02:03Z',
      messages: [
        {
          id: 'message-3',
          content: 'Resolved note',
          timestamp: 'not a date',
          user_id: 'user-3',
          user: { email: 'third@example.com' },
        },
      ],
    },
  })

  assert.deepEqual(normalized[0], {
    threadId: 'thread-open',
    resolved: false,
    resolvedAt: '',
    messages: [
      {
        id: 'message-1',
        content: 'First line\n  indented line',
        timestamp: '2024-03-09T16:00:00.000Z',
        userId: 'user-1',
        author: 'Reviewer One',
      },
      {
        id: 'message-2',
        content: 'Reply\nwith  internal   spacing',
        timestamp: '2024-03-10T12:30:00.000Z',
        userId: 'user-2',
        author: 'Second Reviewer',
      },
    ],
  })
  assert.equal(normalized[1].resolved, true)
  assert.equal(normalized[1].resolvedAt, '2024-04-01T01:02:03.000Z')
  assert.equal(normalized[1].messages[0].author, 'third@example.com')
  assert.equal(normalized[1].messages[0].timestamp, '')
})

test('normalizeThreads rejects arrays and malformed thread/message shapes', () => {
  assert.throws(() => normalizeThreads([]), /thread response/i)
  assert.throws(
    () => normalizeThreads({ bad: { messages: 'not-an-array' } }),
    /messages/i
  )
  assert.throws(
    () =>
      normalizeThreads({
        bad: { messages: [{ id: '', content: 'missing stable id' }] },
      }),
    /message ID/i
  )
  assert.throws(
    () =>
      normalizeThreads({
        bad: { messages: [{ id: 'm', content: null }] },
      }),
    /content/i
  )
})

test('buildExportModel joins only by thread ID and keeps unlocated records', () => {
  const selectionA = buildSelection('same text\ncontext', 0, 4)
  const selectionB = buildSelection('same text\ncontext', 5, 9)
  const threads = normalizeThreads({
    'thread-a': thread('message-a', 'identical first body'),
    'thread-b': thread('message-b', 'identical first body', true),
    'thread-detached': thread('message-c', 'detached'),
    'thread-unseen': thread('message-d', 'not in editor'),
  })
  const model = buildExportModel({
    project: 'Project',
    projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    generated: '2026-07-13T20:00:00.000Z',
    scope: 'all',
    threads,
    scanResult: {
      documents: [
        { documentId: 'doc-a', filePath: 'chapters/a.tex' },
        { documentId: 'doc-b', filePath: 'appendix/a.tex' },
      ],
      locations: [
        location('thread-a', 'doc-a', [selectionA]),
        location('thread-b', 'doc-b', [selectionB], true),
        location('thread-detached', 'doc-a', []),
        location('dangling-thread', 'doc-a', [selectionA]),
      ],
      issues: [
        {
          documentId: 'doc-timeout',
          filePath: 'slow.tex',
          code: 'DOCUMENT_OPEN_TIMEOUT',
          message: 'Timed out.',
        },
      ],
    },
  })

  assert.deepEqual(
    model.records.map(record => [
      record.threadId,
      record.filePath,
      record.fragment,
      record.position,
    ]),
    [
      ['thread-b', 'appendix/a.tex', 'text', 5],
      ['thread-a', 'chapters/a.tex', 'same', 0],
      ['thread-detached', null, '', ''],
      ['thread-unseen', null, '', ''],
    ]
  )
  assert.equal(model.records[0].status, 'resolved')
  assert.equal(model.records[1].status, 'open')
  assert.equal(model.records[1].file, 'chapters/a.tex')
  assert.match(model.records[1].context, /^1: same text/m)
  assert.equal(model.records[2].documentId, 'doc-a')
  assert.match(model.records[2].unlocatedReason, /detached|deleted/i)
  assert.equal(model.records[3].file, '(unlocated)')
  assert.deepEqual(model.summary, {
    filesScanned: 2,
    total: 4,
    located: 2,
    unlocated: 2,
    open: 3,
    resolved: 1,
    perFile: [
      { file: 'appendix/a.tex', count: 1 },
      { file: 'chapters/a.tex', count: 1 },
      { file: '(unlocated)', count: 2 },
    ],
    issues: [
      {
        documentId: 'doc-timeout',
        filePath: 'slow.tex',
        code: 'DOCUMENT_OPEN_TIMEOUT',
        message: 'Timed out.',
      },
      {
        documentId: 'doc-a',
        filePath: 'chapters/a.tex',
        code: 'THREAD_NOT_FOUND',
        message: 'Source range references a thread absent from /threads.',
        threadId: 'dangling-thread',
      },
    ],
    partial: true,
  })
})

test('current scope exports only thread IDs attached to the current document', () => {
  const selection = buildSelection('alpha', 0, 5)
  const model = buildExportModel({
    project: 'Project',
    projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    generated: '2026-07-13T20:00:00.000Z',
    scope: 'current',
    threads: normalizeThreads({
      current: thread('m-current', 'current'),
      detached: thread('m-detached', 'detached'),
      other: thread('m-other', 'other'),
    }),
    scanResult: {
      documents: [{ documentId: 'doc-current', filePath: 'main.tex' }],
      locations: [
        location('current', 'doc-current', [selection]),
        location('detached', 'doc-current', []),
      ],
      issues: [],
    },
  })

  assert.deepEqual(model.records.map(record => record.threadId), [
    'current',
    'detached',
  ])
  assert.equal(model.summary.total, 2)
  assert.equal(model.summary.unlocated, 1)
})

test('Markdown includes exact selections, numbered context, discussions, and warning', () => {
  const model = representativeModel()
  const markdown = buildMarkdown(model)

  assert.match(markdown, /^# Overleaf comments — Project/m)
  assert.match(markdown, /Partial export/i)
  assert.match(markdown, /## chapters\/main\.tex/)
  assert.match(markdown, /Thread `thread-located` — open/)
  assert.match(markdown, /Lines 2:1–2:5/)
  assert.match(markdown, /1 \| before/)
  assert.match(markdown, /2 \| selected line/)
  assert.match(markdown, /First line\nSecond line/)
  assert.match(markdown, /## Unlocated/)
  assert.match(markdown, /No source range was found/)
})

test('JSON schema 2 retains compatibility aliases and additive fields', () => {
  const parsed = JSON.parse(buildJson(representativeModel()))

  assert.equal(parsed.schemaVersion, 2)
  assert.equal(parsed.project, 'Project')
  assert.equal(parsed.filesScanned, 1)
  assert.equal(parsed.totalComments, 2)
  assert.ok(Array.isArray(parsed.perFile))
  assert.equal(parsed.records[0].file, 'chapters/main.tex')
  assert.equal(parsed.records[0].fragment, 'sele')
  assert.equal(parsed.records[0].position, 7)
  assert.equal(parsed.records[0].selections[0].start.line, 2)
  assert.equal(parsed.records[0].messages[0].id, 'message-located')
  assert.equal(parsed.records[1].filePath, null)
  assert.deepEqual(parsed.records[1].selections, [])
})

test('CSV keeps original columns first and appends location/message fields', () => {
  const csv = buildCsv(representativeModel())
  const [header] = csv.split('\n')

  assert.equal(
    header,
    'file,thread_id,resolved,position,fragment,context,author,timestamp,comment,document_id,status,start_line,start_column,end_line,end_column,unlocated_reason,message_id'
  )
  assert.match(
    csv,
    /"chapters\/main\.tex","thread-located","false","7","sele"/
  )
  assert.match(csv, /"doc-main","open","2","1","2","5"/)
  assert.match(csv, /"message-located"/)
  assert.match(csv, /"First line\nSecond line"/)
})

test('scan hard-fails thread fetch before document scanning or downloading', async t => {
  const dom = projectDom()
  t.after(() => dom.window.close())
  let scanned = false
  const downloads = []

  const result = await scan({
    root: dom.window,
    fetch: async () => ({ ok: false, status: 403 }),
    scanDocumentsFn: async () => {
      scanned = true
      return { documents: [], locations: [], issues: [] }
    },
    download: (...args) => downloads.push(args),
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /403/)
  assert.equal(scanned, false)
  assert.deepEqual(downloads, [])
  assert.equal(dom.window.__olceProgress.phase, 'error')
  assert.equal(dom.window.__olceProgress.done, true)
})

test('scan defaults to Markdown and JSON, reports counts, progress, and downloads', async t => {
  const dom = projectDom()
  t.after(() => dom.window.close())
  const downloads = []
  const phases = []
  const selection = buildSelection('selected', 0, 8)

  const result = await scan({
    root: dom.window,
    now: () => new Date('2026-07-13T20:00:00.000Z'),
    fetch: async (url, init) => {
      assert.equal(
        url,
        '/project/aaaaaaaaaaaaaaaaaaaaaaaa/threads'
      )
      assert.equal(init.credentials, 'include')
      assert.equal(init.headers.Accept, 'application/json')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          located: thread('message-1', 'body'),
          unlocated: thread('message-2', 'missing'),
        }),
      }
    },
    scanDocumentsFn: async options => {
      options.onProgress({ fileIndex: 1, fileTotal: 1, fileName: 'main.tex' })
      return {
        documents: [{ documentId: 'doc-main', filePath: 'main.tex' }],
        locations: [location('located', 'doc-main', [selection])],
        issues: [],
      }
    },
    download: (name, text, mime) => downloads.push({ name, text, mime }),
    onProgress: progress => phases.push(progress.phase),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.formats, ['md', 'json'])
  assert.equal(result.filesScanned, 1)
  assert.equal(result.totalComments, 2)
  assert.equal(result.located, 1)
  assert.equal(result.unlocated, 1)
  assert.equal(result.open, 2)
  assert.equal(result.resolved, 0)
  assert.equal(result.partial, true)
  assert.deepEqual(result.perFile, [
    { file: 'main.tex', count: 1 },
    { file: '(unlocated)', count: 1 },
  ])
  assert.equal(downloads.length, 2)
  assert.match(downloads[0].name, /\.md$/)
  assert.match(downloads[1].name, /\.json$/)
  assert.ok(phases.includes('reading'))
  assert.ok(phases.includes('scanning'))
  assert.ok(phases.includes('formatting'))
  assert.ok(phases.includes('downloading'))
  assert.equal(dom.window.__olceProgress.phase, 'done')
  assert.equal(dom.window.__olceProgress.done, true)
})

function representativeModel() {
  const content = ['before', 'selected line', 'after'].join('\n')
  const selection = buildSelection(content, 7, 11)
  return buildExportModel({
    project: 'Project',
    projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    generated: '2026-07-13T20:00:00.000Z',
    scope: 'all',
    threads: normalizeThreads({
      'thread-located': {
        messages: [
          {
            id: 'message-located',
            content: 'First line\nSecond line',
            timestamp: '2026-07-13T19:00:00Z',
            user_id: 'reviewer',
            user: { name: 'Reviewer' },
          },
        ],
      },
      'thread-unlocated': thread('message-unlocated', 'Missing'),
    }),
    scanResult: {
      documents: [
        { documentId: 'doc-main', filePath: 'chapters/main.tex' },
      ],
      locations: [
        location('thread-located', 'doc-main', [selection]),
      ],
      issues: [],
    },
  })
}

function thread(messageId, content, resolved = false) {
  return {
    resolved,
    resolved_at: resolved ? '2026-07-01T00:00:00Z' : undefined,
    messages: [
      {
        id: messageId,
        content,
        timestamp: '2026-07-01T01:00:00Z',
        user_id: 'reviewer-id',
        user: { name: 'Same Reviewer' },
      },
    ],
  }
}

function location(threadId, documentId, selections, resolved = false) {
  return { threadId, documentId, resolved, selections }
}

function projectDom() {
  return new JSDOM(
    '<meta name="ol-projectName" content="Project">',
    {
      url: 'https://www.overleaf.com/project/aaaaaaaaaaaaaaaaaaaaaaaa',
    }
  )
}
