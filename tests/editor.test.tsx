import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Two checks. (1) Without Studio: the pane lists top-level clips (nested rows
// hidden), a press selects a clip, a seek moves the playhead, Split hands the
// CLI the exact argv, and a split outside the clip is refused before anything
// runs. (2) With Studio: the selection poll lands in the pane, moves the
// playhead to Studio's time, and the next prompt the person types carries it.
// Everything beneath the plugin (fs, process, http, store, env, clock, pane
// placement) is answered here.

const PROJ = '/proj'
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const LAUNCHER = '/home/.claude/plugins/cache/hyperframes/hyperframes/0.8.96/skills/hyperframes/scripts/plugin-cli.mjs'

const row = (id: string, trackKind: string, absStart: number, absEnd: number, extra: Record<string, unknown> = {}) => ({
  id,
  ref: `#${id}`,
  file: 'index.html',
  trackKind,
  absStart,
  absEnd,
  nested: false,
  children: [],
  src: null,
  ...extra,
})

const TIMELINE = {
  timeline: {
    duration: 10,
    tracks: [
      {
        kind: 'graphics',
        rows: [
          row('intro', 'graphics', 0, 4, { children: [{ kind: 'graphics', index: 1 }] }),
          row('intro-bg', 'graphics', 0, 4, { nested: true, file: 'compositions/intro.html' }),
          row('outro', 'graphics', 4, 10, { src: 'compositions/outro.html' }),
        ],
      },
      { kind: 'audio', rows: [row('bgm', 'audio', 0, 10, { src: 'bgm.mp3' })] },
    ],
  },
}

const STUDIO_STATUS = {
  ok: true,
  result: { state: 'running', serverUrl: 'http://127.0.0.1:3061', studioUrl: 'http://127.0.0.1:3061/#project/proj', projectName: 'proj' },
}

const STUDIO_SELECTION = {
  selection: {
    sourceFile: 'compositions/outro.html',
    currentTime: 7.5,
    target: { id: 'outro-title', hfId: 'hf-abcd', selector: '#outro-title' },
    label: 'Outro title',
    textContent: 'Thanks for   watching',
  },
  updatedAt: '2026-10-05T00:00:01Z',
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'cutroom',
  props: {
    title: 'Cutroom',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 50, isFullscreen: true },
}

function world(on: On, options: { studio: boolean }) {
  const ran: string[][] = []
  mock.env(on, { HOME: '/home' })
  mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', (_, e) => ({
    value: e.path === LAUNCHER || e.path === `${PROJ}/hyperframes.json` || e.path === `${PROJ}/index.html`,
  }))
  on('fs.list', (_, e) => ({
    value: e.path.includes('/plugins/cache/')
      ? [{ name: '0.8.96', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }]
      : e.path.endsWith('/cutroom')
        ? [{ name: 'frame-00-at-6s.png', kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }]
        : [],
  }))
  on('fs.read', () => ({ value: { base64: PNG_1X1 } }))
  on('fs.write', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: PROJ }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('http.fetch', () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(STUDIO_SELECTION) } }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const sub = e.argv[0] === 'node' ? e.argv.slice(2) : e.argv
    let stdout = ''
    if (sub[0] === 'timeline' && sub[1] === '--json') stdout = JSON.stringify(TIMELINE)
    else if (sub[0] === 'timeline') stdout = JSON.stringify({ ok: true, receipt: { file: 'index.html', changed: true } })
    else if (sub[0] === 'preview' && sub[1] === '--status') stdout = options.studio ? JSON.stringify(STUDIO_STATUS) : JSON.stringify({ ok: true, result: { state: 'stopped' } })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, clock }
}

const COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

test('without Studio: clips list, select, seek and split reach the HyperFrames CLI', async ($, on) => {
  const { ran } = world(on, { studio: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'cutroom', surface, ...PANE })
    expect(await empty.find({ text: /No HyperFrames project/ })).toBeDefined()
    await empty.unmount()
  }

  await $.command.run({ command: 'cut', args: PROJ, ...COMPOSER })
  expect(ran.some(a => a[0] === 'node' && a[1] === LAUNCHER && a[2] === 'timeline' && a[3] === '--json')).toBe(true)
  expect(ran.some(a => a[2] === 'preview' && a[3] === '--background')).toBe(true)

  const ui = await $.ui.mount({ plugin: 'cutroom', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'clip:intro' })).toBeDefined()
  expect(await ui.find({ key: 'clip:outro' })).toBeDefined()
  expect(await ui.find({ key: 'clip:bgm' })).toBeDefined()
  expect((await ui.find({ key: 'clip:intro-bg' })) === undefined).toBe(true)

  await ui.press({ key: 'clip:outro' })
  expect(await ui.find({ text: /clip outro · 4–10s/ })).toBeDefined()
  await ui.input({ key: 'goto', text: '6' })
  expect(await ui.find({ type: 'Text', text: ' 6s ' })).toBeDefined()
  await ui.press({ key: 'split' })
  const split = ran.find(a => a.includes('split'))
  expect(split?.slice(2)).toEqual(['timeline', 'split', '#outro', '6', '--json'])
  expect(await ui.find({ text: /split ✓/ })).toBeDefined()
  expect(await ui.find({ text: /Undo \(1\)/ })).toBeDefined()

  await ui.input({ key: 'goto', text: '2' })
  await ui.press({ key: 'split' })
  expect(ran.filter(a => a.includes('split')).length).toBe(1)
  expect(await ui.find({ text: /playhead inside the clip/ })).toBeDefined()
  await ui.unmount()
})

test('with Studio: the selection poll lands in the pane and rides the next typed prompt', async ($, on) => {
  const { ran, clock } = world(on, { studio: true })
  const entered: Array<readonly string[] | undefined> = []
  on('prompt.submit', (_, e) => {
    entered.push(e.context)
    return { text: e.text, context: e.context }
  })

  await $.command.run({ command: 'cut', args: PROJ, ...COMPOSER })
  expect(ran.some(a => a[0] === 'open' && a[1] === 'http://localhost:3061/#project/proj')).toBe(true)

  await clock.advance(1600) // one poll period: selection lands, playhead follows, a capture is scheduled
  await clock.advance(600) // the debounced capture fires
  const ui = await $.ui.mount({ plugin: 'cutroom', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /Studio: Outro title · compositions\/outro.html · in clip outro/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 7.5s ' })).toBeDefined()
  expect(ran.some(a => a[0] === 'curl' && String(a[a.length - 1]).includes('/api/projects/proj/thumbnail/index.html?t=7.5'))).toBe(true)

  await $.prompt.submit({ text: 'make this bigger', wait: false, origin: { kind: 'composer' } })
  const ctx = entered[0]?.join('\n') ?? ''
  expect(ctx).toContain('Studio selection')
  expect(ctx).toContain('#outro-title')
  expect(ctx).toContain('text "Thanks for watching"')
  expect(ctx).toContain('Playhead: 7.5s')

  await ui.press({ key: 'ctx' })
  await $.prompt.submit({ text: 'unrelated question', wait: false, origin: { kind: 'composer' } })
  expect(entered[1] === undefined || entered[1].length === 0).toBe(true)
  await ui.unmount()
})
