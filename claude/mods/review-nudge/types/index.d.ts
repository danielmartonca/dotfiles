// The band on screen: the repos with unreviewed edits and what made the work look done; null when hidden.
export type Nudge = { repos: string[]; reason: string } | null

declare module 'claude-code' {
  interface PluginState {
    // dirty: repo root -> edits since its last review. snoozedAt: the edit total when the person said "Not yet".
    'review-nudge': { dirty: Shaped<Record<string, number>>; nudge: Shaped<Nudge>; snoozedAt: number }
  }
}
