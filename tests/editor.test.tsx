import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Three checks, all without HyperFrames Studio. (1) The timeline is one track
// cut into segments at every clip edge, each named for the shortest clip under it
// (nested rows ignored); a press selects a segment and moves the playhead, a drag
// scrubs, a click that delivers only its up still selects, and a tap on the video
// plays. (2) The next prompt the person types carries the selected segment and
// the playhead. (3) The live player streams frames into the pane on every surface
// and takes play and seek; the segments carry real frames.
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

const LIVE_JPEG = '/9j/4AAQSkZJRgABAQ' // any string: the desktop draws it inside an Svg
const LIVE_RGB = (w: number, h: number) => btoa(String.fromCharCode(...new Uint8Array(w * h * 3).fill(128)))

function world(on: On, options: { live?: boolean }) {
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
  const cmds: Array<{ op: string; t?: number }> = []
  const player = { t: 0, paused: true, seq: 1 }
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    const reply = (body: unknown) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } })
    if (url.pathname === '/cmd') {
      const q = (k: string) => url.searchParams.get(k)
      const c: { op: string; t?: number; n?: number } = e.init?.body
        ? JSON.parse(e.init.body)
        : { op: String(q('op')), ...(q('t') !== null ? { t: Number(q('t')) } : {}), ...(q('n') !== null ? { n: Number(q('n')) } : {}) }
      cmds.push(c)
      if (c.op === 'toggle') player.paused = !player.paused
      if (c.op === 'seek') player.t = c.t ?? 0
      player.seq++
      const frames = c.op === 'strip' ? Array.from({ length: c.n ?? 0 }, () => LIVE_JPEG) : undefined
      return reply({ ok: true, state: { t: player.t, d: 10, paused: player.paused, ...(frames ? { frames } : {}) } })
    }
    const since = Number(url.searchParams.get('since'))
    const rgbW = Number(url.searchParams.get('rgb') ?? 0)
    const rgbH = Math.round((rgbW * 480) / 854)
    return reply({
      seq: player.seq,
      t: player.t,
      d: 10,
      paused: player.paused,
      ...(player.seq > since ? { jpeg: LIVE_JPEG, ...(rgbW ? { rgb: LIVE_RGB(rgbW, rgbH), rgbW, rgbH } : {}) } : {}),
    })
  })
  on('process.spawn', async function* (_, e, next) {
    ran.push([...e.argv])
    if (!options.live) {
      yield { stream: 'stdout' as const, text: '{"error":"no chrome in tests"}\n' }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout' as const, text: '{"port":7777,"duration":10}\n' }
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const sub = e.argv[0] === 'node' ? e.argv.slice(2) : e.argv
    let stdout = ''
    if (sub[0] === 'osascript') stdout = '/Users/me/Movies/My Clip.mov\n'
    if (sub[0] === 'timeline' && sub[1] === '--json') stdout = JSON.stringify(TIMELINE)
    else if (sub[0] === 'timeline') stdout = JSON.stringify({ ok: true, receipt: { file: 'index.html', changed: true } })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, clock, cmds, player }
}

const COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

// the terminal timeline laid out 80 cells wide for 10s (8 cells a second); row 0 is the ruler, row 1 the track
const X = (t: number) => t * 8

test('timeline: one track of segments; press selects, drag scrubs, cut tools reach the CLI, a tap plays', async ($, on) => {
  const { ran, cmds } = world(on, { live: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'cutroom', surface, ...PANE })
    expect(await empty.find({ text: /No HyperFrames project/ })).toBeDefined()
    await empty.unmount()
  }

  await $.command.run({ command: 'cut', args: PROJ, ...COMPOSER })
  expect(ran.some(a => a[0] === 'node' && a[1] === LAUNCHER && a[2] === 'timeline' && a[3] === '--json')).toBe(true)
  expect(ran.some(a => a.includes('preview'))).toBe(false) // no Studio

  // cuts at 0, 4 and 10: "intro" (shorter than the 10s bgm) then "outro"
  const desk = await $.ui.mount({ plugin: 'cutroom', surface: 'desktop', ...PANE })
  const tlNode = await desk.find({ key: 'timeline' })
  const segs = (tlNode?.props.props as { segments: Array<{ id: string; label: string; start: number; end: number }> }).segments
  expect(segs).toEqual([
    { id: 'intro', label: 'Intro', start: 0, end: 4 },
    { id: 'outro', label: 'Outro', start: 4, end: 10 },
  ])
  const track = (await desk.findAll({ type: 'Svg' })).map(n => String(n.props.source)).find(src => src.includes('>Outro<'))
  expect(track?.includes('>Intro<')).toBe(true)
  await desk.unmount()

  const ui = await $.ui.mount({ plugin: 'cutroom', surface: 'terminal', ...PANE })
  await ui.resize({ columns: 80, rows: 3, in: 'timeline' })

  // press inside outro: the playhead moves there and the segment is selected
  await ui.pointer({ type: 'down', x: X(5), y: 1, button: 'left', in: 'timeline' })
  expect(await ui.find({ text: /00:05\.0/ })).toBeDefined()
  expect(await ui.find({ text: /Outro, 4-10s selected/ })).toBeDefined()
  // drag scrubs
  await ui.pointer({ type: 'move', x: X(7), y: 1, button: 'left', in: 'timeline' })
  expect(await ui.find({ text: /00:07\.0/ })).toBeDefined()
  await ui.pointer({ type: 'up', x: X(7), y: 1, button: 'left', in: 'timeline' })

  // the cut tools act on the selected segment's clip at the playhead (now 7s), undoably
  await ui.press({ key: 'split' })
  expect(ran.find(a => a.includes('split'))?.slice(2)).toEqual(['timeline', 'split', '#outro', '7', '--json'])
  expect(await ui.find({ text: /split done/ })).toBeDefined()
  expect(await ui.find({ key: 'undo', text: /Undo \(1\)/ })).toBeDefined()
  await ui.press({ key: 'trim-out' })
  expect(ran.find(a => a.includes('trim'))?.slice(2)).toEqual(['timeline', 'trim', '#outro', '--end', '7', '--json'])

  // a click that only delivers its up still selects
  await ui.pointer({ type: 'up', x: X(1), y: 1, button: 'left', in: 'timeline' })
  expect(await ui.find({ text: /Intro, 0-4s selected/ })).toBeDefined()

  // one tap on the video plays it
  await ui.pointer({ type: 'down', x: 2, y: 2, button: 'left', in: 'tap' })
  expect(cmds.some(c => c.op === 'toggle')).toBe(true)
  await ui.unmount()
})

test('the selected segment and the playhead ride the next typed prompt; Upload brings a file in', async ($, on) => {
  const { ran } = world(on, {})
  const entered: Array<readonly string[] | undefined> = []
  on('prompt.submit', (_, e) => {
    entered.push(e.context)
    return { text: e.text, context: e.context }
  })

  await $.command.run({ command: 'cut', args: PROJ, ...COMPOSER })
  const ui = await $.ui.mount({ plugin: 'cutroom', surface: 'desktop', ...PANE })
  await ui.post({ op: 'press', id: 'outro', t: 4 }, { in: 'timeline' })
  await ui.unmount()

  await $.prompt.submit({ text: 'make this bigger', wait: false, origin: { kind: 'composer' } })
  const ctx = entered[0]?.join('\n') ?? ''
  expect(ctx).toContain('Selected segment')
  expect(ctx).toContain('4–10s of the video, shown as "Outro"')
  expect(ctx).toContain('outro on the graphics track, 4–10s')
  expect(ctx).toContain('Playhead: 4s')
  expect(ctx.includes('Studio')).toBe(false)

  // Upload: the system file dialog, the file copied into assets/, Claude asked to place it
  const pane = await $.ui.mount({ plugin: 'cutroom', surface: 'desktop', ...PANE })
  await pane.press({ key: 'upload' })
  expect(ran.some(a => a[0] === 'cp' && a[1] === '/Users/me/Movies/My Clip.mov' && a[2] === `${PROJ}/assets/My-Clip.mov`)).toBe(true)
  expect(await pane.find({ text: /Added assets\/My-Clip\.mov/ })).toBeDefined()
  await pane.unmount()
})

test('live player: the helper starts, frames stream into the pane on every surface, play and seek go to it', async ($, on) => {
  const { ran, clock, cmds, player } = world(on, { live: true })
  await $.command.run({ command: 'cut', args: PROJ, ...COMPOSER })
  await clock.advance(50)
  const helper = ran.find(a => String(a[1]).endsWith('/player/cutroom-player.mjs'))
  expect(helper?.[0]).toBe('node')
  expect(JSON.parse(String(helper?.[2])).project).toBe(PROJ)

  await clock.advance(250) // a couple of 100 ms polls
  const desk = await $.ui.mount({ plugin: 'cutroom', surface: 'desktop', ...PANE })
  const svg = await desk.find({ type: 'Svg' })
  expect(String(svg?.props.source)).toContain(`data:image/jpeg;base64,${LIVE_JPEG}`)
  expect(cmds.some(c => c.op === 'strip')).toBe(true)
  const lanes = (await desk.findAll({ type: 'Svg' })).map(n => String(n.props.source)).find(src => src.includes('>Outro<'))
  expect(lanes?.includes('<use href="#f')).toBe(true) // the segments carry real frames
  expect(await desk.find({ text: /Live/ })).toBeDefined()

  await desk.press({ key: 'play' })
  expect(cmds.some(c => c.op === 'toggle')).toBe(true)
  await clock.advance(150)
  expect(await desk.find({ key: 'play', text: '❚❚' })).toBeDefined()
  await desk.press({ key: 'play' })
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'cutroom', surface: 'terminal', ...PANE })
  await clock.advance(250) // the terminal asks for rgb, the next poll brings it and redraws
  expect(await term.find({ type: 'Raster' })).toBeDefined()
  await term.press({ key: 'seek-p1' })
  expect(cmds.some(c => c.op === 'seek' && c.t === player.t && c.t > 0)).toBe(true)
  await term.unmount()
})
