import { expect, mock, test } from 'claude-code/testing'

// One check: the pane lists top-level clips (nested rows hidden), a press
// selects a clip, a seek moves the playhead, and Split hands the CLI the
// exact `timeline split <ref> <t> --json` argv. Everything beneath the
// plugin (fs, process, store, env, clock, pane placement) is answered here.

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
          row('outro', 'graphics', 4, 10),
        ],
      },
      { kind: 'audio', rows: [row('bgm', 'audio', 0, 10, { src: 'bgm.mp3' })] },
    ],
  },
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

test('clips list, select, seek and split reach the HyperFrames CLI', async ($, on) => {
  const ran: string[][] = []
  mock.env(on, { HOME: '/home' })
  mock.store(on)
  mock.clock(on)
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
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const sub = e.argv[0] === 'node' ? e.argv.slice(2) : e.argv
    let stdout = ''
    if (sub[0] === 'timeline' && sub[1] === '--json') stdout = JSON.stringify(TIMELINE)
    else if (sub[0] === 'timeline') stdout = JSON.stringify({ ok: true, receipt: { file: 'index.html', changed: true } })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  // no project yet: both surfaces draw the empty state
  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'cutroom', surface, ...PANE })
    expect(await empty.find({ text: /No HyperFrames project/ })).toBeDefined()
    await empty.unmount()
  }

  // /cut /proj opens the project and reads its timeline
  await $.command.run({ command: 'cut', args: PROJ, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.some(a => a[0] === 'node' && a[1] === LAUNCHER && a[2] === 'timeline' && a[3] === '--json')).toBe(true)

  const ui = await $.ui.mount({ plugin: 'cutroom', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'clip:intro' })).toBeDefined()
  expect(await ui.find({ key: 'clip:outro' })).toBeDefined()
  expect(await ui.find({ key: 'clip:bgm' })).toBeDefined()
  expect((await ui.find({ key: 'clip:intro-bg' })) === undefined).toBe(true)

  // select outro (playhead jumps to its start), seek to 6s, split there
  await ui.press({ key: 'clip:outro' })
  expect(await ui.find({ text: /selected outro/ })).toBeDefined()
  await ui.input({ key: 'goto', text: '6' })
  expect(await ui.find({ text: /playhead 6s/ })).toBeDefined()
  await ui.press({ key: 'split' })
  const split = ran.find(a => a.includes('split'))
  expect(split?.slice(2)).toEqual(['timeline', 'split', '#outro', '6', '--json'])
  expect(await ui.find({ text: /split ✓/ })).toBeDefined()
  expect(await ui.find({ text: /Undo \(1\)/ })).toBeDefined()

  // split outside the clip is refused before any process runs
  const before = ran.length
  await ui.input({ key: 'goto', text: '2' })
  await ui.press({ key: 'split' })
  expect(ran.filter(a => a.includes('split')).length).toBe(1)
  expect(ran.length - before).toBeLessThanOrEqual(1) // at most the seek's snapshot
  expect(await ui.find({ text: /playhead inside the clip/ })).toBeDefined()
  await ui.unmount()
})
