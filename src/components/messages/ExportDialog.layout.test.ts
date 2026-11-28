import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const browser =
  [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => path && existsSync(path)) ?? null

type Rect = {
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

type ScrollBox = Rect & {
  clientHeight: number
  scrollHeight: number
  overflowY: string
}

type Measurement = {
  viewport: [number, number]
  dialog: ScrollBox
  header: Rect
  main: ScrollBox
  footer: Rect
  buttons: Rect[]
  switchColumns: number
}

type CdpMessage = {
  id?: number
  result?: unknown
  error?: { message?: string }
}

class CdpClient {
  private nextId = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >()

  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === undefined) {
        return
      }
      const request = this.pending.get(message.id)
      if (!request) {
        return
      }
      this.pending.delete(message.id)
      if (message.error) {
        request.reject(new Error(message.error.message ?? 'CDP request failed'))
      } else {
        request.resolve(message.result)
      }
    }
  }

  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('CDP WebSocket connection failed'))
    })
    return new CdpClient(socket)
  }

  send<T>(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const startBrowser = async (executable: string, profile: string) => {
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  )
  let stderr = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const endpoint = await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (cause?: unknown, url?: string) => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      if (cause) {
        reject(cause)
      } else if (url) {
        resolve(url)
      } else {
        reject(new Error('Browser DevTools endpoint was not reported'))
      }
    }
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString()
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(stderr)
      if (match) {
        finish(undefined, match[1])
      }
    }
    const onExit = (code: number | null) => {
      finish(new Error(`Browser exited before DevTools was ready (code ${code})`))
    }
    timer = setTimeout(
      () => finish(new Error(`Timed out waiting for browser DevTools: ${stderr}`)),
      20000
    )
    child.stderr.on('data', onData)
    child.once('exit', onExit)
  })
  return { child, endpoint }
}

const pageSocketUrl = async (port: string) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = (await response.json()) as Array<{
          type?: string
          webSocketDebuggerUrl?: string
        }>
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl
        }
      }
    } catch {
      // DevTools endpoint is still starting.
    }
    await delay(50)
  }
  throw new Error('Browser DevTools page target was not available')
}

const buildHtml = (marker: string) => {
  const read = (file: string) => readFileSync(join(root, file), 'utf8')
  const dialog = /<Modal[\s\S]*?className=\{styles\.(\w+)\}/u.exec(
    read('src/components/messages/ExportDialog.tsx')
  )?.[1]
  const body = /mainClassName=\{styles\.(\w+)\}/u.exec(
    read('src/components/messages/ExportDialog.tsx')
  )?.[1]
  if (!dialog || !body) {
    throw new Error('ExportDialog must keep its dialog and body class names')
  }
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
    :root {
      --app-safe-top: 16px;
      --app-safe-right: 0px;
      --app-safe-bottom: 16px;
      --app-safe-left: 0px;
      --dsw-alias-bg-layer-2: #ffffff;
      --dsw-alias-bg-base: #ffffff;
      --dsw-alias-label-primary: #111111;
      --dsw-alias-label-secondary: #555555;
      --dsw-alias-border-l2: #dddddd;
      --dsw-alias-border-inverted: #eeeeee;
      --dsw-alias-markdown-code-block: #f5f5f5;
      --dsw-alias-state-error-primary: #b00000;
    }
    ${read('src/components/base/Modal.module.css')}
    ${read('src/components/messages/ExportDialog.module.css')}
    .close { display: block; width: 32px; height: 32px; }
    .control { box-sizing: border-box; width: 96px; height: 36px; border-radius: 9px; background: #e7e7e7; }
    .switch { box-sizing: border-box; width: 44px; height: 26px; border-radius: 13px; background: #cccccc; }
    .fake-button {
      box-sizing: border-box;
      height: 40px;
      min-width: 72px;
      padding: 0 14px;
      border: 1px solid #cccccc;
      border-radius: 999px;
      background: #ffffff;
      font: inherit;
    }
  </style>
</head>
<body data-layout="${marker}">
  <div class="overlay">
    <div class="content ${dialog}" id="dialog">
      <div class="header" id="header">
        <div class="title">导出</div>
        <span class="close"></span>
      </div>
      <div class="main ${body}" id="main">
        <div class="field"><span>导出格式</span><span class="control"></span></div>
        <div class="field"><span>导出主题</span><span class="control"></span></div>
        <div class="switches" id="switches">
          <div class="switchRow"><span>包含提问</span><span class="switch"></span></div>
          <div class="switchRow"><span>包含模型</span><span class="switch"></span></div>
          <div class="switchRow"><span>包含思考</span><span class="switch"></span></div>
        </div>
        <div class="previewViewport">
          <div class="previewSizer" style="height: 300px">
            <div class="previewScale"><div style="width: 720px; height: 560px; background: #ffffff"></div></div>
          </div>
        </div>
      </div>
      <div class="footer" id="footer">
        <button class="fake-button">分享</button>
        <button class="fake-button">保存</button>
      </div>
    </div>
  </div>
</body>
</html>`
}

const measureExpression = `(() => {
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      right: box.right,
      bottom: box.bottom,
    }
  }
  const scrollBox = (element) => {
    const box = rect(element)
    const style = getComputedStyle(element)
    return {
      ...box,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
    }
  }
  const dialog = document.getElementById('dialog')
  const switches = document.getElementById('switches')
  const columns = getComputedStyle(switches).gridTemplateColumns
  return {
    viewport: [innerWidth, innerHeight],
    dialog: scrollBox(dialog),
    header: rect(document.getElementById('header')),
    main: scrollBox(document.getElementById('main')),
    footer: rect(document.getElementById('footer')),
    buttons: [...document.querySelectorAll('#footer button')].map(rect),
    switchColumns: columns === 'none' ? 0 : columns.split(' ').filter(Boolean).length,
  }
})()`

const measure = async (
  cdp: CdpClient,
  url: string,
  marker: string,
  width: number,
  height: number
) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await cdp.send('Page.navigate', { url })
  const expression = `document.readyState === 'complete' && document.body?.dataset.layout === ${JSON.stringify(marker)}`
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (state.result.value === true) {
      break
    }
    await delay(50)
  }
  const measured = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
    expression: measureExpression,
    returnByValue: true,
  })
  const value = measured.result.value
  if (!value || typeof value !== 'object') {
    throw new Error('Browser returned no layout measurement')
  }
  return value as Measurement
}

const assertInside = (rect: Rect, bounds: Rect, label: string) => {
  assert.ok(rect.x >= bounds.x - 0.5, `${label} starts left of its bounds`)
  assert.ok(rect.y >= bounds.y - 0.5, `${label} starts above its bounds`)
  assert.ok(rect.right <= bounds.right + 0.5, `${label} ends right of its bounds`)
  assert.ok(rect.bottom <= bounds.bottom + 0.5, `${label} ends below its bounds`)
}

test('keeps export dialog header, body and footer reachable on narrow screens', async (t) => {
  if (!browser) {
    t.skip('Chrome or Edge is required for the export dialog layout regression test')
    return
  }
  if (typeof WebSocket === 'undefined' || typeof fetch !== 'function') {
    t.skip('This Node.js runtime does not provide the browser automation APIs')
    return
  }

  const temp = mkdtempSync(join(tmpdir(), 'deepchat-export-layout-'))
  const mobileFile = join(temp, 'mobile.html')
  const desktopFile = join(temp, 'desktop.html')
  writeFileSync(mobileFile, buildHtml('mobile'))
  writeFileSync(desktopFile, buildHtml('desktop'))
  let child: ChildProcess | undefined
  let cdp: CdpClient | undefined
  try {
    const launched = await startBrowser(browser, join(temp, 'profile'))
    child = launched.child
    cdp = await CdpClient.connect(await pageSocketUrl(new URL(launched.endpoint).port))
    await cdp.send('Page.enable')

    const mobile = await measure(cdp, pathToFileURL(mobileFile).href, 'mobile', 320, 712)
    assert.deepEqual(mobile.viewport, [320, 712])
    assert.ok(Math.abs(mobile.dialog.x - 16) < 1, 'narrow dialog keeps 16px side insets')
    assert.ok(Math.abs(mobile.dialog.width - 288) < 1, 'narrow dialog uses the available width')
    assert.equal(mobile.dialog.overflowY, 'hidden')
    assert.equal(mobile.main.overflowY, 'auto')
    assert.ok(mobile.main.scrollHeight > mobile.main.clientHeight, 'long content scrolls')
    assert.ok(mobile.main.height > 0, 'content area keeps usable height')
    assert.ok(mobile.main.bottom <= mobile.footer.y + 0.5, 'footer follows the scrolling content')
    assert.ok(mobile.footer.bottom <= mobile.dialog.bottom - 12, 'footer stays inside the dialog')
    assert.ok(
      mobile.footer.bottom <= mobile.viewport[1] - 16 + 0.5,
      'footer stays above the safe-area inset'
    )
    assert.ok(mobile.header.y >= mobile.dialog.y, 'header stays inside the dialog')
    assert.ok(mobile.header.bottom <= mobile.main.y + 0.5, 'header stays above the content')
    assert.equal(mobile.switchColumns, 1, 'narrow layout keeps single-column switches')
    assert.ok(mobile.buttons.length === 2, 'narrow layout renders both actions')
    for (const button of mobile.buttons) {
      assertInside(button, mobile.dialog, 'narrow action button')
      assert.ok(button.bottom <= mobile.viewport[1], 'narrow action button stays on screen')
    }

    const desktop = await measure(cdp, pathToFileURL(desktopFile).href, 'desktop', 1280, 900)
    assert.deepEqual(desktop.viewport, [1280, 900])
    assert.ok(Math.abs(desktop.dialog.width - 760) < 1, 'desktop dialog keeps its width')
    assert.equal(desktop.switchColumns, 3, 'desktop layout keeps three switch columns')
    assert.ok(desktop.footer.bottom <= desktop.dialog.bottom - 12, 'desktop footer stays in dialog')
    assert.ok(desktop.buttons.length === 2, 'desktop layout renders both actions')
    for (const button of desktop.buttons) {
      assertInside(button, desktop.dialog, 'desktop action button')
    }
  } finally {
    cdp?.close()
    if (child?.exitCode === null) {
      child.kill()
      await Promise.race([once(child, 'exit'), delay(2000)])
    }
    if (child?.exitCode === null) {
      child.kill('SIGKILL')
      await Promise.race([once(child, 'exit'), delay(1000)])
    }
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
