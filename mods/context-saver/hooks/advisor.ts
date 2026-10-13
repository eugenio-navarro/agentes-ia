import type { SessionContextBreakdown, SessionRateLimit, SessionUsage } from 'claude-code'

import type { AdviceKind, Cut, Figures, Gauge, Ledger, Level, Pause, Signals } from '../types'

/** Every threshold the mod decides by, written once. */
export const LIMITS = {
  /** Under this share of the window the mod says nothing. */
  quietBelow: 40,
  /** From here green tests are a good moment to compact. */
  compactAt: 60,
  /** From here it insists, before auto-compaction picks the moment. */
  urgentAt: 80,
  /** Without a turn for this long after a commit, the person is taken to have stepped away. */
  settledMs: 10 * 60 * 1000,
  /** Without a turn for this long the prompt cache is taken as lapsed. */
  idleMs: 60 * 60 * 1000,
  /** A tool result of this many tokens or more is named. */
  bigOutputTokens: 10_000,
  /** Whole reads of one file before it is named. */
  repeatedReads: 3,
  /** A rate-limit window used this far or more is drawn as a caution. */
  rateLimitCaution: 60,
  /** A rate-limit window used this far or more is announced, once. */
  rateLimitWarn: 80,
  /** A prompt of fewer words is a reply, not a subject: it is neither compared nor remembered. */
  topicMinWords: 6,
  /** How many earlier prompts a new one is compared with, and how much of each is sent. */
  topicHistory: 3,
  topicClipChars: 300,
  /** The most the small model is asked in one session. */
  topicAsksPerSession: 30,
  /** How often the band re-reads the engine's figures while nothing else does. */
  refreshMs: 60_000,
  /** A bar's length in cells: no shorter than reads as a bar, no longer than looks like one. */
  barMinCells: 7,
  barMaxCells: 16,
  /** A cell's width and a bar's height where the surface draws vectors, in CSS pixels. */
  cellPx: 8,
  barHeightPx: 8,
  /** The row's spacing in cells: between its parts, and inside a gauge or between buttons. */
  rowGapCells: 2,
  innerGapCells: 1,
  /** What a button takes around its label. */
  buttonPadCells: 4,
  /** The bars of the /uso report: in pixels where drawn as vectors, in cells as text. */
  reportBarPx: 120,
  reportBarCells: 20,
  /** The column the labels under a title of the report take, so its rows start together. */
  reportLabelCells: 28,
  /** The agents the report lists one by one, heaviest first; the rest are summed up. */
  agentsListed: 6,
  /** The most of an agent's task the report repeats. */
  agentClipChars: 60,
} as const

export const COMPACT_INSTRUCTIONS =
  'Conservá: la tarea en curso y su objetivo, las decisiones tomadas y su porqué, ' +
  'los archivos modificados y su estado, los tests y comandos corridos con su resultado, ' +
  'y lo pendiente. Descartá: salidas largas de herramientas, exploraciones descartadas ' +
  'y el contenido de archivos ya leídos.'

/** The signals before anything is known. */
export const QUIET_SIGNALS: Signals = { percent: null, cut: null, pause: 'none', hidden: null, topic: null }

/** The ledger of a conversation that has spent nothing yet. */
export const EMPTY_LEDGER: Ledger = {
  bigOutputs: [],
  fullReads: {},
  prompts: [],
  classifier: { asked: 0, tokens: 0 },
  agents: [],
  windows: [],
}

/**
 * State as this version reads it. The host keeps state across a reload, so what is stored
 * may come from an earlier version with fewer fields: those take their defaults.
 */
export const signalsFrom = (stored: Partial<Signals> | null | undefined): Signals => ({
  ...QUIET_SIGNALS,
  ...stored,
})

export const ledgerFrom = (stored: Partial<Ledger> | null | undefined): Ledger => ({
  ...EMPTY_LEDGER,
  ...stored,
  // 0.12.0 kept a count of the agents, not a list: that is started over.
  agents: Array.isArray(stored?.agents) ? stored.agents : [],
})

/**
 * The usage windows to show: those the engine reports now, in the order first seen, and any
 * it reported before and has left out since. The engine drops a window once it resets, so a
 * remembered one reads as it was until its reset time and 0% after it: it never disappears.
 */
export const windowsShown = (
  reported: readonly SessionRateLimit[],
  remembered: readonly SessionRateLimit[],
  nowMs: number,
): SessionRateLimit[] => {
  const kinds = [...new Set([...remembered, ...reported].map(one => one.kind))]

  return kinds.flatMap(kind => {
    const now = reported.find(one => one.kind === kind)
    const last = remembered.find(one => one.kind === kind)

    if (now !== undefined || last === undefined) {
      return now ?? []
    }

    const hasReset = last.resetsAt !== undefined && Date.parse(last.resetsAt) <= nowMs

    return hasReset ? { kind, percentUsed: 0 } : last
  })
}

/** The part of a breakdown the report reads. */
export type Breakdown = Pick<SessionContextBreakdown, 'categories' | 'mcpTools'>

const COMMIT = /\bgit\s+(?:-\S+\s+)*commit\b/
const TESTS =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b|\b(?:go|cargo|dotnet|mvn|gradle|gradlew(?:\.bat)?)\s+test\b/

/** The natural cut a shell command stands for when it succeeds, if any. */
export const cutOf = (command: string): Cut | null => {
  if (COMMIT.test(command)) {
    return 'commit'
  }

  return TESTS.test(command) ? 'tests' : null
}

/** Which advice the signals call for now, or null to stay quiet. */
export const adviceFor = ({ percent, cut, pause, hidden, topic }: Signals): AdviceKind | null => {
  if (percent === null || percent < LIMITS.quietBelow) {
    return null
  }

  const kind = pressingOf(percent, cut, pause, topic)

  return kind === hidden ? null : kind
}

const pressingOf = (
  percent: number,
  cut: Cut | null,
  pause: Pause,
  topic: string | null,
): AdviceKind | null => {
  // Committed and then left alone: nothing in the conversation is unsaved work.
  if (cut === 'commit' && pause !== 'none') {
    return 'done'
  }

  // The earlier subject is dead weight: a compaction that keeps only the new one frees the most.
  if (topic !== null) {
    return 'topic'
  }

  if (percent >= LIMITS.urgentAt) {
    return 'urgent'
  }

  if (pause === 'long') {
    return 'idle'
  }

  return cut !== null && percent >= LIMITS.compactAt ? 'cut' : null
}

/**
 * The command an advice recommends. /clear only when the work is saved: anything else may
 * still need what the conversation holds, which /compact keeps.
 */
export const commandFor = (kind: AdviceKind): 'compact' | 'clear' =>
  kind === 'done' ? 'clear' : 'compact'

/** A prompt as it is remembered and sent: one line, clipped. */
export const clipPrompt = (text: string): string =>
  text.trim().replace(/\s+/g, ' ').slice(0, LIMITS.topicClipChars)

/** Whether a prompt states a subject: long enough, and not a slash command. */
export const isSubstantial = (text: string): boolean =>
  !text.trimStart().startsWith('/') && text.trim().split(/\s+/).length >= LIMITS.topicMinWords

/**
 * Whether asking the small model about a change of subject can pay for itself: there is
 * enough context to be worth clearing, something to compare with, and the session's cap
 * is not spent. Every check here is free.
 */
export const isWorthAsking = (ask: {
  text: string
  percent: number | null
  known: number
  asked: number
}): boolean =>
  ask.percent !== null &&
  ask.percent >= LIMITS.quietBelow &&
  ask.known > 0 &&
  ask.asked < LIMITS.topicAsksPerSession &&
  isSubstantial(ask.text)

export const TOPIC_SYSTEM =
  'Clasificás si el mensaje nuevo de un usuario continúa el trabajo de sus mensajes anteriores ' +
  'o empieza un tema distinto. Respondé con una sola palabra: MISMO o NUEVO. Ante la duda, MISMO.'

/** What the small model is asked: the earlier prompts, then the new one. */
export const topicQuestion = (previous: readonly string[], next: string): string =>
  [
    'Mensajes anteriores del usuario:',
    ...previous.map(one => `- ${clipPrompt(one)}`),
    '',
    'Mensaje nuevo:',
    clipPrompt(next),
  ].join('\n')

/** The model's one-word answer; anything else, or both words at once, is no answer. */
export const topicAnswer = (reply: string): 'new' | 'same' | null => {
  const said = reply.toUpperCase()
  const isNew = said.includes('NUEVO')

  return isNew === said.includes('MISMO') ? null : isNew ? 'new' : 'same'
}

/** What a compaction is told after a change of subject: keep the new one only. */
export const topicInstructions = (topic: string): string =>
  `Cambio de tema. Conservá solo lo que sirva para el tema nuevo: «${topic}». ` +
  'Descartá la conversación anterior a ese mensaje, salvo las decisiones o los archivos que el tema nuevo necesite.'

/** A local estimate, about four characters to a token; never the API's count. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** A whole number with a dot every three digits, as Spanish writes thousands. */
export const formatCount = (count: number): string =>
  String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/** A path's last segment. */
export const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

const WINDOW_LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d' }

/** A rate-limit window's short name: 5h, 7d, or the engine's own word. */
export const windowLabelOf = (kind: string): string => WINDOW_LABELS[kind] ?? kind

const gaugeOf = (label: string, percent: number, warnAt: number, dangerAt: number): Gauge => ({
  label,
  percent: Math.round(percent),
  level: percent >= dangerAt ? 'danger' : percent >= warnAt ? 'warn' : 'ok',
})

/** What the band draws, or null before the engine has a figure to show. */
export const figuresOf = ({ context, cost, rateLimits }: SessionUsage): Figures | null => {
  if (context.percent === undefined) {
    return null
  }

  return {
    context: gaugeOf('Contexto', context.percent, LIMITS.compactAt, LIMITS.urgentAt),
    limits: rateLimits.map(limit =>
      gaugeOf(
        windowLabelOf(limit.kind),
        limit.percentUsed,
        LIMITS.rateLimitCaution,
        LIMITS.rateLimitWarn,
      ),
    ),
    cost: cost === undefined ? null : `$${cost.usd.toFixed(2)}`,
  }
}

/** The figures as one plain line, for a surface that draws no band. */
export const statusTextOf = (figures: Figures | null): string | undefined =>
  figures === null
    ? undefined
    : [figures.context, ...figures.limits]
        .map(gauge => `${gauge.label} ${gauge.percent}%`)
        .concat(figures.cost === null ? [] : [costTextOf(figures.cost)])
        .join(' · ')

/** How long until `iso`, in its two largest units; null for a date that does not parse. */
export const resetIn = (iso: string, nowMs: number): string | null => {
  const minutes = Math.round((Date.parse(iso) - nowMs) / 60_000)

  if (Number.isNaN(minutes)) {
    return null
  }

  if (minutes <= 0) {
    return 'ahora'
  }

  const units = [
    [Math.floor(minutes / 1440), 'd'],
    [Math.floor(minutes / 60) % 24, 'h'],
    [minutes % 60, 'min'],
  ] as const
  const first = units.findIndex(([amount]) => amount > 0)

  return `en ${units
    .slice(first, first + 2)
    .filter(([amount]) => amount > 0)
    .map(([amount, unit]) => `${amount} ${unit}`)
    .join(' ')}`
}

/** The session's price as the band and the status line write it. */
export const costTextOf = (cost: string): string => `Precio: ${cost}`

const WIDEST_PERCENT = '100%'.length

/**
 * Cells the band's row takes without its bars: every text, the buttons and the gaps. A
 * percentage counts at its widest, so a bar keeps its length as the figure grows.
 */
export const rowCellsOf = (shown: Figures, buttons: readonly string[]): number => {
  const sum = (cells: readonly number[]) => cells.reduce((total, one) => total + one, 0)
  const gauges = [shown.context, ...shown.limits].map(
    gauge => gauge.label.length + WIDEST_PERCENT + 2 * LIMITS.innerGapCells,
  )
  const cost = shown.cost === null ? [] : [costTextOf(shown.cost).length]
  const pressed =
    buttons.length === 0
      ? []
      : [
          sum(buttons.map(label => label.length + LIMITS.buttonPadCells)) +
            (buttons.length - 1) * LIMITS.innerGapCells,
        ]
  const parts = [...gauges, ...cost, ...pressed]

  return sum(parts) + (parts.length - 1) * LIMITS.rowGapCells
}

/**
 * Cells for each of the row's `bars`: the room a band `columns` wide leaves once `taken`
 * is drawn, shared between them and kept within what reads as a bar. The gaps never
 * stretch: what room there is goes to the bars.
 */
export const barCellsFor = (columns: number, taken: number, bars: number): number =>
  Math.min(LIMITS.barMaxCells, Math.max(LIMITS.barMinCells, Math.floor((columns - taken) / bars)))

/** How many of a bar's `cells` are filled at `percent`; any use at all fills one. */
export const filledCells = (percent: number, cells: number): number =>
  Math.min(cells, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * cells)))

/**
 * A rounded bar as SVG markup, for a surface that draws vectors: the track, with what is
 * used over it. Any use at all shows at least a round dot.
 */
export const barSvg = (
  percent: number,
  color: string,
  track: string,
  width: number,
  height: number,
): string => {
  const used = percent <= 0 ? 0 : Math.max(height, Math.round((Math.min(percent, 100) / 100) * width))
  const rect = (rectWidth: number, fill: string) =>
    `<rect width="${rectWidth}" height="${height}" rx="${height / 2}" fill="${fill}"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${rect(width, track)}${used > 0 ? rect(used, color) : ''}</svg>`
  )
}

/** A token count as people say it: 950, 12k, 476k, 1,3M. */
export const shortCount = (count: number): string => {
  if (count < 1000) {
    return String(Math.round(count))
  }

  return count < 999_500
    ? `${Math.round(count / 1000)}k`
    : `${String(Math.round(count / 100_000) / 10).replace('.', ',')}M`
}

const REPORT_BAR_CELLS = LIMITS.reportBarCells
const CONTEXT_TITLE = 'Qué ocupa el contexto'
const DETAIL_TITLE = 'Detalle del gasto'
const AGENTS_TITLE = 'Agentes'
const NO_AGENTS = 'No se usaron agentes en esta sesión.'
const REPORT_LABEL_WIDTH = 10
const WINDOW_NAMES: Readonly<Record<string, string>> = { five_hour: '5 horas', seven_day: '7 días' }

/** The engine's category names, gathered under the four names the report shows. */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Conversación', ['Messages']],
  ['Herramientas', ['System tools', 'MCP tools', 'Custom agents']],
  ['Skills', ['Skills']],
  ['Instrucciones y memoria', ['System prompt', 'Memory files']],
]

/** One figure of the report: its name, a bar, the percentage and what else is worth saying. */
const figureRow = (name: string, percent: number, detail: string | null): string => {
  const used = filledCells(percent, REPORT_BAR_CELLS)
  const bar = '█'.repeat(used) + '░'.repeat(REPORT_BAR_CELLS - used)
  const shown = `${Math.round(percent)}%`.padStart(4)

  return `${name.padEnd(REPORT_LABEL_WIDTH)}${bar} ${shown}${detail === null ? '' : ` · ${detail}`}`
}

/** What fills the window, grouped and largest first; a category the mod does not know keeps its name. */
const groupRows = (categories: Breakdown['categories']): string[] => {
  const used = categories.filter(row => row.kind === 'used' && row.tokens > 0)
  const total = used.reduce((sum, row) => sum + row.tokens, 0)
  const grouped = new Set(GROUPS.flatMap(([, names]) => names))
  const sumOf = (rows: readonly { tokens: number }[]) => rows.reduce((sum, row) => sum + row.tokens, 0)

  return [
    ...GROUPS.map(([name, names]) => [name, sumOf(used.filter(row => names.includes(row.name)))] as const),
    ...used.filter(row => !grouped.has(row.name)).map(row => [row.name, row.tokens] as const),
  ]
    .filter(([, tokens]) => tokens > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([name, tokens]) => `• ${name}: ${shortCount(tokens)} (${Math.round((tokens / total) * 100)}%)`)
}

/** The three connectors whose loaded tools take the most room. */
const heaviestConnectors = (tools: Breakdown['mcpTools']): string[] => {
  const loaded = new Map<string, number>()

  for (const tool of tools.filter(one => one.isLoaded)) {
    loaded.set(tool.serverName, (loaded.get(tool.serverName) ?? 0) + tool.tokens)
  }

  return [...loaded]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([name, tokens]) => `${name} ${shortCount(tokens)}`)
}

const listed = (title: string, items: readonly string[]): string[] =>
  items.length === 0 ? [] : [`• ${title}: ${items.join(' · ')}`]

/** The level a share of a limit is drawn at: the same thresholds the gauges use. */
export const levelFor = (percent: number): Level =>
  percent >= LIMITS.urgentAt ? 'danger' : percent >= LIMITS.compactAt ? 'warn' : 'ok'

/**
 * The agents noted after one of an agent's turns. An agent is listed once however many
 * turns it runs; its tokens are all its turns processed, cached or not, and a turn that
 * reports no usage adds none. `known` is what the engine says of it, asked the first time.
 */
export const agentNoted = (
  agents: Ledger['agents'],
  id: string,
  usage:
    | {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens: number
        cache_creation_input_tokens: number
      }
    | undefined,
  known: { type: string; description: string } | undefined,
): Ledger['agents'] => {
  const spent =
    usage === undefined
      ? 0
      : usage.input_tokens +
        usage.output_tokens +
        usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens

  if (agents.some(one => one.id === id)) {
    return agents.map(one => (one.id === id ? { ...one, tokens: one.tokens + spent } : one))
  }

  // One line, with nothing the report's own separator could be taken for.
  const description = (known?.description ?? '')
    .replace(/\|/g, '/')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, LIMITS.agentClipChars)

  return [...agents, { id, type: known?.type ?? 'agente', description, tokens: spent }]
}

/** A command's text without the plugin's name the engine puts before it where it shows it. */
export const withoutName = (text: string, plugin: string): string =>
  text.startsWith(`${plugin}: `) ? text.slice(plugin.length + 2) : text

/** One line of the /uso report, as the transcript draws it. */
export type ReportBlock =
  | { kind: 'figure'; label: string; percent: number; detail: string | null }
  | { kind: 'share'; label: string; percent: number; amount: string }
  | { kind: 'fact'; label: string; value: string }
  | { kind: 'detail'; label: string; value: string }
  | { kind: 'agent'; type: string; description: string; amount: string }
  | { kind: 'title'; text: string }
  | { kind: 'note'; text: string }

const FIGURE_LINE = /^(.+?)\s+[█░]+\s+(\d+)%(?: · (.*))?$/
const SHARE_LINE = /^• (.+): (\S+) \((\d+)%\)$/
const AGENT_LINE = /^• (.+?) \| (.*) \| (.+)$/
const DETAIL_LINE = /^• ([^:]+): (.+)$/
const FACT_LINE = /^([^:]+): (.+)$/

/**
 * Reads the report's own text back into what each line is, so the transcript can draw it
 * with the band's bars and colours. The text stays the one thing the model and a surface
 * without the drawing read; this only ever reads what `reportOf` writes.
 */
export const reportBlocks = (text: string): ReportBlock[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line): ReportBlock => {
      const figure = FIGURE_LINE.exec(line)

      if (figure !== null) {
        return {
          kind: 'figure',
          label: (figure[1] ?? '').trim(),
          percent: Number(figure[2]),
          detail: figure[3] ?? null,
        }
      }

      const agent = AGENT_LINE.exec(line)

      if (agent !== null) {
        return { kind: 'agent', type: agent[1] ?? '', description: agent[2] ?? '', amount: agent[3] ?? '' }
      }

      const share = SHARE_LINE.exec(line)

      if (share !== null) {
        return { kind: 'share', label: share[1] ?? '', amount: share[2] ?? '', percent: Number(share[3]) }
      }

      const detail = DETAIL_LINE.exec(line)

      if (detail !== null) {
        return { kind: 'detail', label: detail[1] ?? '', value: detail[2] ?? '' }
      }

      const fact = FACT_LINE.exec(line)

      if (fact !== null) {
        return { kind: 'fact', label: fact[1] ?? '', value: fact[2] ?? '' }
      }

      return line === CONTEXT_TITLE || line === DETAIL_TITLE || line === AGENTS_TITLE
        ? { kind: 'title', text: line }
        : { kind: 'note', text: line }
    })

/**
 * The /uso report: a bar for the context and each usage window, the cost, what fills the
 * context, and what the conversation spent it on. Only lines the person can act on, and
 * every part after the first under a title of its own; the agents close it, one a line,
 * or a line saying there were none.
 */
export const reportOf = (
  usage: SessionUsage,
  breakdown: Breakdown | undefined,
  ledger: Ledger,
  nowMs: number,
): string => {
  const { context, cost, rateLimits } = usage
  const figures = [
    context.percent === undefined || context.tokens === undefined
      ? `${'Contexto'.padEnd(REPORT_LABEL_WIDTH)}sin datos todavía`
      : figureRow(
          'Contexto',
          context.percent,
          `${shortCount(context.tokens)} de ${shortCount(context.window)} tokens`,
        ),
    ...rateLimits.map(limit => {
      const reset = limit.resetsAt === undefined ? null : resetIn(limit.resetsAt, nowMs)

      return figureRow(
        WINDOW_NAMES[limit.kind] ?? limit.kind,
        limit.percentUsed,
        reset === null ? null : `se reinicia ${reset}`,
      )
    }),
    ...(cost === undefined ? [] : [`Precio de la sesión: $${cost.usd.toFixed(2)}`]),
  ]
  const groups = breakdown === undefined ? [] : groupRows(breakdown.categories)
  const repeated = Object.entries(ledger.fullReads)
    .filter(([, times]) => times > 1)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
  const spent = [
    ...listed('Conectores más pesados', breakdown === undefined ? [] : heaviestConnectors(breakdown.mcpTools)),
    ...listed(
      'Salidas grandes',
      [...ledger.bigOutputs]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 3)
        .map(one => `${[one.tool, one.target].filter(Boolean).join(' ')} ~${shortCount(one.tokens)}`),
    ),
    ...listed(
      'Releídos enteros',
      repeated.map(([path, times]) => `${baseName(path)} ×${times}`),
    ),
    ...(ledger.classifier.asked === 0
      ? []
      : [
          `• Detección de cambio de tema: ${ledger.classifier.asked} ${ledger.classifier.asked === 1 ? 'consulta' : 'consultas'} del mod a Haiku · ${formatCount(ledger.classifier.tokens)} tokens`,
        ]),
  ]

  const hasReading = context.percent !== undefined && context.tokens !== undefined
  const heaviest = [...ledger.agents].sort((a, b) => b.tokens - a.tokens)
  const rest = heaviest.slice(LIMITS.agentsListed)
  const agents =
    heaviest.length === 0
      ? hasReading
        ? [AGENTS_TITLE, NO_AGENTS]
        : []
      : [
          AGENTS_TITLE,
          ...heaviest
            .slice(0, LIMITS.agentsListed)
            .map(one => `• ${one.type} | ${one.description} | ${shortCount(one.tokens)} tokens`),
          ...(rest.length === 0
            ? []
            : [`y ${rest.length} más: ${shortCount(rest.reduce((total, one) => total + one.tokens, 0))} tokens`]),
        ]

  return [
    figures,
    groups.length === 0 ? [] : [CONTEXT_TITLE, ...groups],
    spent.length === 0 ? [] : [DETAIL_TITLE, ...spent],
    agents,
  ]
    .filter(lines => lines.length > 0)
    .map(lines => lines.join('\n'))
    .join('\n\n')
}
