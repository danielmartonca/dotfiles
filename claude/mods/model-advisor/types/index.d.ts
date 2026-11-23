export type Tier = 'sonnet' | 'opus'

// A suggestion on screen; null when there is none. muted: the person asked for no more this session.
export type Advice = { target: Tier; alias: string; kind: string; from: string; shownAt: number } | null

// What the advisor made of the last prompt, for /model-advisor.
export type LastCheck = { prompt: string; kind: string | null; model: string; tokens: number | null; outcome: string } | null

declare module 'claude-code' {
  interface PluginState {
    'model-advisor': { advice: Shaped<Advice>; muted: boolean; last: LastCheck; pending: string | null }
  }
}
