/** A natural stopping point seen in the turn: a commit made, or tests passing. */
export type Cut = 'commit' | 'tests'

/**
 * Why the band recommends acting on the context: the work is saved and the person stepped
 * away, the window is nearly full, a long pause let the cache lapse, or a natural cut.
 */
export type AdviceKind = 'done' | 'topic' | 'urgent' | 'idle' | 'cut'

/** How long since the last turn: none yet, a break, or long enough for the cache to lapse. */
export type Pause = 'none' | 'short' | 'long'

/** What the advice is decided from; `percent` is null until the first response. */
export type Signals = {
  percent: number | null
  cut: Cut | null
  pause: Pause
  hidden: AdviceKind | null
  /** The prompt that changed the subject, clipped, while that is still worth acting on. */
  topic: string | null
}

/** A tool result that put many tokens into the main conversation at once. */
export type BigOutput = { tool: string; target: string; tokens: number }

/** What the session has spent context on, for the /ahorro report. */
export type Ledger = {
  bigOutputs: BigOutput[]
  fullReads: Record<string, number>
  /** The person's last substantial prompts, clipped: what a new one is compared with. */
  prompts: string[]
  /** How often the small model was asked about a change of subject, and what that cost. */
  classifier: { asked: number; tokens: number }
  /** The subagents launched so far: what each is, what for, and every token its turns processed. */
  agents: { id: string; type: string; description: string; tokens: number }[]
  /** The usage windows seen so far, so one the engine leaves out stays on screen. */
  windows: { kind: string; percentUsed: number; resetsAt?: string }[]
}

/** How close a figure is to its limit, which is the colour it is drawn in. */
export type Level = 'ok' | 'warn' | 'danger'

/** One percentage of the band: its label, whole percent and level. */
/** `isStale` marks a figure in doubt: its reading is old or assumed, so a dash is drawn in its place. */
export type Gauge = { label: string; percent: number; level: Level; isStale?: true }

/** What the band draws: context, rate-limit windows, cost. */
export type Figures = { context: Gauge; limits: Gauge[]; cost: string | null }

declare module 'claude-code' {
  interface PluginState {
    'context-saver': { signals: Signals; ledger: Ledger; figures: Figures | null }
  }
}
