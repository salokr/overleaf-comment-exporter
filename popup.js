/* Overleaf Comment Exporter — popup controller. */

;(function exposePopup(root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    api.mount(root.document, root.chrome)
  }
})(typeof globalThis === 'object' ? globalThis : this, function createPopup() {
  'use strict'

  const PHASE_LABELS = {
    reading: 'Reading comments',
    discovering: 'Discovering files',
    scanning: 'Scanning files',
    restoring: 'Restoring editor',
    formatting: 'Formatting',
    downloading: 'Downloading',
    done: 'Done',
    error: 'Error',
  }

  function isOverleafProject(url) {
    return /^https:\/\/([a-z0-9-]+\.)*overleaf\.com\/project\/[0-9a-f]{24}(?:\/|$)/i.test(
      url || ''
    )
  }

  async function invokePageScanner(options) {
    const scanner = globalThis.__olceScanner
    try {
      if (!scanner || typeof scanner.scan !== 'function') {
        throw new Error('The Overleaf page scanner is unavailable.')
      }
      return await scanner.scan(options)
    } finally {
      delete globalThis.__olceScanner
    }
  }

  async function runPageScan(chromeApi, tabId, options) {
    const target = { tabId }
    await chromeApi.scripting.executeScript({
      target,
      world: 'MAIN',
      files: ['page-scanner.js'],
    })
    const results = await chromeApi.scripting.executeScript({
      target,
      world: 'MAIN',
      func: invokePageScanner,
      args: [options],
    })
    if (!results?.[0] || !('result' in results[0])) {
      throw new Error('The Overleaf page scanner returned no result.')
    }
    return results[0].result
  }

  function readOptions(documentRoot) {
    return {
      scope:
        documentRoot.querySelector('input[name="scope"]:checked')
          ?.value || 'all',
      formats: {
        md: Boolean(documentRoot.getElementById('fmt-md')?.checked),
        csv: Boolean(documentRoot.getElementById('fmt-csv')?.checked),
        json: Boolean(documentRoot.getElementById('fmt-json')?.checked),
      },
    }
  }

  function renderResult(element, result) {
    element.hidden = false
    if (!result?.ok) {
      element.className = 'result bad'
      element.textContent = result?.error || 'Something went wrong.'
      return
    }

    const partial = Boolean(result.partial)
    element.className = partial ? 'result partial' : 'result'
    const perFile = Array.isArray(result.perFile) ? result.perFile : []
    const issues = Array.isArray(result.issues) ? result.issues : []
    const fileRows = perFile
      .map(
        item =>
          `<tr><td>${escapeHtml(item.file)}</td><td>${numberValue(item.count)}</td></tr>`
      )
      .join('')
    const warningItems = issues
      .map(issue => {
        const subject = issue.filePath || issue.documentId || 'project'
        const text = `${issue.code || 'WARNING'}: ${issue.message || 'Scan warning.'} (${subject})`
        return `<li>${escapeHtml(text)}</li>`
      })
      .join('')
    const warning = partial
      ? `<section class="partial-warning" role="status"><strong>Partial export</strong><p>Some comments or files could not be fully linked.</p>${warningItems ? `<ul>${warningItems}</ul>` : ''}</section>`
      : ''
    const formatText = (result.formats || [])
      .map(formatLabel)
      .join(', ')

    element.innerHTML =
      `<h2>${partial ? 'Exported with warnings' : 'Export complete'}</h2>` +
      '<dl class="counts">' +
      countItem('Files scanned', result.filesScanned) +
      countItem('Total threads', result.totalComments) +
      countItem('Located', result.located) +
      countItem('Unlocated', result.unlocated) +
      countItem('Open', result.open) +
      countItem('Resolved', result.resolved) +
      '</dl>' +
      warning +
      (fileRows
        ? `<table aria-label="Threads per file"><tbody>${fileRows}</tbody></table>`
        : '') +
      `<p class="downloaded">Downloaded: ${escapeHtml(formatText || 'nothing')}.</p>`
  }

  function countItem(label, value) {
    return `<div><dt>${label}</dt><dd>${numberValue(value)}</dd></div>`
  }

  function numberValue(value) {
    return Number.isFinite(value) ? value : 0
  }

  function formatLabel(format) {
    return (
      {
        md: 'Markdown',
        json: 'JSON',
        csv: 'CSV',
      }[format] || String(format).toUpperCase()
    )
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character]
    })
  }

  function progressValues(progress) {
    const phase = progress?.phase || 'reading'
    const fileIndex = numberValue(progress?.fileIndex)
    const fileTotal = numberValue(progress?.fileTotal)
    let overall = progress?.overall

    if (!Number.isFinite(overall)) {
      if (phase === 'reading') overall = 0.04
      else if (phase === 'discovering') overall = 0.08
      else if (phase === 'scanning') {
        overall = fileTotal
          ? 0.1 + (Math.max(0, fileIndex - 1) / fileTotal) * 0.75
          : 0.1
      } else if (phase === 'restoring') overall = 0.87
      else if (phase === 'formatting') overall = 0.92
      else if (phase === 'downloading') overall = 0.97
      else if (phase === 'done') overall = 1
      else overall = 0
    }

    let fileProgress = progress?.fileProgress
    if (!Number.isFinite(fileProgress)) {
      fileProgress = phase === 'done' ? 1 : 0
    }

    return {
      phase,
      label: PHASE_LABELS[phase] || 'Working',
      overall: clamp(overall),
      fileProgress: clamp(fileProgress),
      fileIndex,
      fileTotal,
      fileName: progress?.fileName || '',
      done: Boolean(progress?.done),
    }
  }

  function clamp(value) {
    return Math.max(0, Math.min(1, value || 0))
  }

  function renderProgress(elements, progress) {
    if (!progress) return
    const view = progressValues(progress)
    elements.progress.hidden = false
    elements.phase.textContent = view.label
    elements.overallFill.style.width = `${(view.overall * 100).toFixed(1)}%`
    elements.overallPct.textContent = `${Math.round(view.overall * 100)}%`
    elements.overallSub.textContent = view.fileTotal
      ? `File ${Math.min(view.fileIndex, view.fileTotal)} of ${view.fileTotal}`
      : ''
    elements.fileFill.style.width = `${(
      view.fileProgress * 100
    ).toFixed(1)}%`
    elements.filePct.textContent = `${Math.round(
      view.fileProgress * 100
    )}%`
    elements.fileName.textContent = view.fileName
    elements.progress.classList.toggle('complete', view.done)
    elements.progress.classList.toggle('failed', view.phase === 'error')
  }

  function readPageProgress() {
    return globalThis.__olceProgress || null
  }

  function mount(documentRoot, chromeApi) {
    const elements = popupElements(documentRoot)
    let activeTab = null
    let pollTimer = null

    async function initialize() {
      try {
        const [tab] = await chromeApi.tabs.query({
          active: true,
          currentWindow: true,
        })
        activeTab = tab
        if (!tab || !isOverleafProject(tab.url)) {
          elements.status.textContent =
            'Open an Overleaf project tab, then open this extension again.'
          elements.status.className = 'status bad'
          return
        }
        elements.status.textContent = 'Ready to export reviewer threads.'
        elements.status.className = 'status ok'
        elements.options.disabled = false
        elements.run.disabled = false
      } catch (error) {
        elements.status.textContent = errorMessage(error)
        elements.status.className = 'status bad'
      }
    }

    function startPolling() {
      elements.progress.hidden = false
      elements.progress.classList.remove('complete', 'failed')
      renderProgress(elements, {
        phase: 'reading',
        fileName: 'Starting…',
      })
      pollTimer = setInterval(async () => {
        try {
          const results = await chromeApi.scripting.executeScript({
            target: { tabId: activeTab.id },
            world: 'MAIN',
            func: readPageProgress,
          })
          if (results?.[0]?.result) {
            renderProgress(elements, results[0].result)
          }
        } catch (_) {
          // Navigation can briefly make the active tab unavailable.
        }
      }, 250)
    }

    function stopPolling(result) {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      if (result?.ok) {
        renderProgress(elements, {
          phase: 'done',
          overall: 1,
          fileProgress: 1,
          done: true,
        })
      } else if (result && !result.ok) {
        renderProgress(elements, {
          phase: 'error',
          done: true,
        })
      }
    }

    elements.run.addEventListener('click', async () => {
      const options = readOptions(documentRoot)
      if (!Object.values(options.formats).some(Boolean)) {
        elements.status.textContent = 'Pick at least one format.'
        elements.status.className = 'status bad'
        return
      }

      elements.run.disabled = true
      elements.run.classList.add('busy')
      elements.run.textContent =
        options.scope === 'all' ? 'Scanning all files…' : 'Scanning…'
      elements.status.textContent =
        'Working — keep this Overleaf tab active.'
      elements.status.className = 'status'
      elements.result.hidden = true
      startPolling()

      let result
      try {
        result = await runPageScan(
          chromeApi,
          activeTab.id,
          options
        )
        renderResult(elements.result, result)
        if (!result?.ok) {
          elements.status.textContent = 'Export failed.'
          elements.status.className = 'status bad'
        } else if (result.partial) {
          elements.status.textContent = 'Finished with warnings.'
          elements.status.className = 'status warn'
        } else {
          elements.status.textContent = 'Finished.'
          elements.status.className = 'status ok'
        }
      } catch (error) {
        result = { ok: false, error: errorMessage(error) }
        renderResult(elements.result, result)
        elements.status.textContent = 'Export failed.'
        elements.status.className = 'status bad'
      } finally {
        stopPolling(result)
        elements.run.disabled = false
        elements.run.classList.remove('busy')
        elements.run.textContent = 'Scan & export'
      }
    })

    initialize()
    return { initialize }
  }

  function popupElements(documentRoot) {
    return {
      status: documentRoot.getElementById('status'),
      options: documentRoot.getElementById('options'),
      run: documentRoot.getElementById('run'),
      result: documentRoot.getElementById('result'),
      progress: documentRoot.getElementById('progress'),
      phase: documentRoot.getElementById('phase'),
      overallFill: documentRoot.getElementById('overall-fill'),
      overallPct: documentRoot.getElementById('overall-pct'),
      overallSub: documentRoot.getElementById('overall-sub'),
      fileFill: documentRoot.getElementById('file-fill'),
      filePct: documentRoot.getElementById('file-pct'),
      fileName: documentRoot.getElementById('file-name'),
    }
  }

  function errorMessage(error) {
    return error?.message || String(error || 'Something went wrong.')
  }

  return {
    isOverleafProject,
    invokePageScanner,
    runPageScan,
    readOptions,
    renderResult,
    progressValues,
    renderProgress,
    mount,
  }
})
