const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const {
  invokePageScanner,
  runPageScan,
  renderResult,
} = require('../popup')

test('runPageScan injects the scanner file before invoking it in MAIN', async () => {
  const calls = []
  const options = {
    scope: 'all',
    formats: { md: true, json: true, csv: false },
  }
  const chromeApi = {
    scripting: {
      async executeScript(details) {
        calls.push(details)
        if (details.files) return []
        return [{ result: { ok: true, totalComments: 2 } }]
      },
    },
  }

  const result = await runPageScan(chromeApi, 42, options)

  assert.equal(result.totalComments, 2)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    target: { tabId: 42 },
    world: 'MAIN',
    files: ['page-scanner.js'],
  })
  assert.equal(calls[1].world, 'MAIN')
  assert.deepEqual(calls[1].target, { tabId: 42 })
  assert.equal(calls[1].func, invokePageScanner)
  assert.deepEqual(calls[1].args, [options])
})

test('invokePageScanner captures the API and always removes the page global', async () => {
  const original = globalThis.__olceScanner
  const options = { scope: 'current', formats: { md: true } }
  try {
    globalThis.__olceScanner = {
      async scan(received) {
        assert.deepEqual(received, options)
        assert.equal(globalThis.__olceScanner, this)
        return { ok: true }
      },
    }
    assert.deepEqual(await invokePageScanner(options), { ok: true })
    assert.equal('__olceScanner' in globalThis, false)

    await assert.rejects(invokePageScanner(options), /scanner.*unavailable/i)
    assert.equal('__olceScanner' in globalThis, false)
  } finally {
    if (original === undefined) delete globalThis.__olceScanner
    else globalThis.__olceScanner = original
  }
})

test('renderResult shows all counts and explicit partial diagnostics', () => {
  const dom = new JSDOM('<div id="result"></div>')
  const element = dom.window.document.getElementById('result')

  renderResult(element, {
    ok: true,
    filesScanned: 3,
    totalComments: 5,
    located: 4,
    unlocated: 1,
    open: 3,
    resolved: 2,
    formats: ['md', 'json'],
    perFile: [
      { file: 'chapters/main.tex', count: 4 },
      { file: '(unlocated)', count: 1 },
    ],
    partial: true,
    issues: [
      {
        code: 'DOCUMENT_OPEN_TIMEOUT',
        filePath: '<slow>.tex',
        message: 'Timed out.',
      },
    ],
  })

  const text = element.textContent
  assert.match(element.className, /partial/)
  assert.match(text, /Exported with warnings/i)
  assert.doesNotMatch(text, /^Done\b/i)
  assert.match(text, /Files scanned\s*3/i)
  assert.match(text, /Total threads\s*5/i)
  assert.match(text, /Located\s*4/i)
  assert.match(text, /Unlocated\s*1/i)
  assert.match(text, /Open\s*3/i)
  assert.match(text, /Resolved\s*2/i)
  assert.match(text, /Markdown, JSON/i)
  assert.match(text, /DOCUMENT_OPEN_TIMEOUT: Timed out\. \(<slow>\.tex\)/)
  assert.doesNotMatch(element.innerHTML, /<slow>/)
  dom.window.close()
})

test('renderResult distinguishes full success and failure', () => {
  const dom = new JSDOM('<div id="result"></div>')
  const element = dom.window.document.getElementById('result')

  renderResult(element, {
    ok: true,
    filesScanned: 1,
    totalComments: 0,
    located: 0,
    unlocated: 0,
    open: 0,
    resolved: 0,
    formats: ['md'],
    perFile: [],
    partial: false,
    issues: [],
  })
  assert.match(element.textContent, /Export complete/i)
  assert.doesNotMatch(element.className, /partial|bad/)

  renderResult(element, { ok: false, error: 'Injection failed.' })
  assert.match(element.className, /bad/)
  assert.equal(element.textContent, 'Injection failed.')
  dom.window.close()
})

test('popup defaults and manifest metadata match the export contract', () => {
  const root = path.join(__dirname, '..')
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8')
  const dom = new JSDOM(html)
  const document = dom.window.document
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
  )

  assert.equal(document.getElementById('fmt-md').checked, true)
  assert.equal(document.getElementById('fmt-json').checked, true)
  assert.equal(document.getElementById('fmt-csv').checked, false)
  assert.doesNotMatch(document.body.textContent, /Review panel/i)
  assert.match(document.body.textContent, /tab.*active/i)
  assert.equal(manifest.version, '1.0.1')
  assert.deepEqual(manifest.permissions, ['scripting', 'activeTab'])
  dom.window.close()
})
