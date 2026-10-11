/** A natural stopping point seen in the turn: a commit made, or tests passing. */
export type Cut = 'commit' | 'tests'

/** Why the band suggests acting on the context, most pressing first. */
export type AdviceKind = 'urgent' | 'idle' | 'commit' | 'tests'

/** What the advice is decided from; `percent` is null until the first response. */
export type Signals = {
  percent: number | null
  cut: Cut | null
  isIdle: boolean
  hidden: AdviceKind | null
}

/** A tool result that put many tokens into the main conversation at once. */
export type BigOutput = { tool: string; target: string; tokens: number }

/** What the session has spent context on, for the /ahorro report. */
export type Ledger = {
  bigOutputs: BigOutput[]
  fullReads: Record<string, number>
}

/** How close a figure is to its limit, which is the colour it is drawn in. */
export type Level = 'ok' | 'warn' | 'danger'

/** One percentage of the band: its label, whole percent and level. */
export type Gauge = { label: string; percent: number; level: Level }

/** What the band draws: context, rate-limit windows, cost. */
export type Figures = { context: Gauge; limits: Gauge[]; cost: string | null }

declare module 'claude-code' {
  interface PluginState {
    'context-saver': { signals: Signals; ledger: Ledger; figures: Figures | null }
  }
}
