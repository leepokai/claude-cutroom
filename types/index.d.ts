export type HfClip = {
  id: string
  ref: string
  file: string
  trackKind: string
  absStart: number
  absEnd: number
  src: string | null
  children: number
}
export type HfTimeline = { duration: number; clips: HfClip[] } | null
export type HfPreview = { at: number; png: string; jpg: string; width: number; height: number; gen: number } | null
export type HfStudio = {
  hfId: string | null
  selector: string | null
  file: string | null
  text: string | null
  time: number | null
} | null

declare module 'claude-code' {
  interface PluginState {
    cutroom: {
      project: string | null
      candidates: string[]
      timeline: HfTimeline
      selected: string | null
      playhead: number
      preview: HfPreview
      studio: HfStudio
      studioUrl: string | null
      status: string
      busy: string
      receipts: string[]
    }
  }
}
