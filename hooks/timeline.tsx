import type { ClientModule } from 'claude-code'

// The Cutroom timeline: one track, cut by time into segments. Press anywhere to
// put the playhead there and select the segment under it; drag to scrub (the
// preview follows). Rows: the ruler, then the track. In a terminal it draws the
// track in text cells (mode "text"); on the desktop the hooks module draws it as
// an Svg with real frames and this region lies over it, transparent (mode
// "overlay"), mapping the pointer by fractions of the region so it lines up with
// any font. Every outcome is posted to the hooks module as { op, ... }.

export type Segment = { id: string; label: string; start: number; end: number }
/** overlay geometry, as fractions of the region: the inset either side of the track, the ruler band */
export type TimelineGeo = { inset: number; ruler: number }
export type TimelineProps = {
  mode: 'text' | 'overlay'
  duration: number
  t: number
  selected: string | null
  segments: Segment[]
  geo?: TimelineGeo
}

const ACCENT = '#d97757'
const DIM = '#a6a39a'
const round = (n: number) => Math.round(n * 100) / 100
// a press is in flight; setState lands a frame late and a drag's events outrun it
// ponytail: module-wide, fine while the pane draws one timeline
let pressing = false

const Timeline: ClientModule<TimelineProps, { pressing: boolean }> = (p, s) => {
  const { Box, Text } = s.elements
  const d = p.duration > 0 ? p.duration : 1
  const cols = Math.max(1, s.columns)

  const timeAt = (x: number, fx?: number) => {
    const u = p.mode === 'overlay' && p.geo ? ((fx ?? x + 0.5) / cols - p.geo.inset) / (1 - 2 * p.geo.inset) : x / cols
    return round(Math.max(0, Math.min(d, u * d)))
  }

  const press = (x: number, fx?: number) => {
    const t = timeAt(x, fx)
    const seg = p.segments.find(g => t >= g.start && t < g.end) ?? p.segments[p.segments.length - 1]
    s.post({ op: 'press', t, id: seg?.id ?? null })
  }
  s.onPointer(ev => {
    if (ev.type === 'down' && ev.button === 'left') {
      pressing = true
      s.setState({ pressing })
      press(ev.x, ev.fine?.x)
    } else if (ev.type === 'move' && pressing && ev.button === 'left') {
      s.post({ op: 'seek', t: timeAt(ev.x, ev.fine?.x) })
    } else if (ev.type === 'up') {
      // a click that only focused the region delivers no down: its up is the press, so one click is enough
      if (!pressing && ev.button === 'left') press(ev.x, ev.fine?.x)
      pressing = false
      s.setState({ pressing })
    }
  })

  if (p.mode === 'overlay') return <Box width="100%" height="100%" />

  // text mode: a ruler with the playhead, then the segments as coloured runs
  const toX = (t: number) => Math.max(0, Math.min(cols - 1, Math.floor((t / d) * cols)))
  const playX = toX(p.t)
  const ruler = Array.from({ length: cols }, () => ' ')
  for (let i = 0; i <= 4; i++) {
    const label = `${round((d * i) / 4)}s`
    const x0 = Math.min(cols - label.length, toX((d * i) / 4))
    for (let k = 0; k < label.length; k++) ruler[x0 + k] = label[k] ?? ' '
  }
  const runs = p.segments.map((g, i) => {
    const a = toX(g.start)
    const b = i === p.segments.length - 1 ? cols : toX(g.end)
    const name = ` ${g.label}`
    let text = ''
    for (let x = a; x < b; x++) text += x === playX ? '│' : x === b - 1 && b < cols ? '▕' : (name[x - a] ?? ' ')
    const isSel = g.id === p.selected
    return { key: `${g.id}:${i}`, text, bg: isSel ? '#d97757' : i % 2 ? '#30302e' : '#3a3936', fg: isSel ? '#141413' : '#f0eee6' }
  })

  return (
    <Box flexDirection="column">
      <Text color={DIM}>{ruler.join('')}</Text>
      <Text>
        {runs.map(r => (
          <Text key={`seg:${r.key}`} backgroundColor={r.bg} color={r.fg}>
            {r.text}
          </Text>
        ))}
      </Text>
      <Text color={ACCENT}>{' '.repeat(playX)}▲</Text>
    </Box>
  )
}

export default Timeline
