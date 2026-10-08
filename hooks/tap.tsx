import type { ClientModule } from 'claude-code'

// A transparent region over the preview: one tap plays or pauses.
// A click that only focuses the region may deliver no down, so the up counts too.
let down = false

const Tap: ClientModule<null, boolean> = (_, s) => {
  s.onPointer(ev => {
    if (ev.button !== 'left') return
    if (ev.type === 'down') {
      down = true
      s.post({ op: 'toggle' })
    } else if (ev.type === 'up') {
      if (!down) s.post({ op: 'toggle' })
      down = false
    }
  })
  const { Box } = s.elements
  return <Box width="100%" height="100%" />
}

export default Tap
