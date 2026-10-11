import type { SessionContextBreakdown, SessionUsage } from 'claude-code'

import type { AdviceKind, Cut, Figures, Gauge, Ledger, Signals } from '../types'

/** Every threshold the mod decides by, written once. */
export const LIMITS = {
  /** Under this share of the window the mod says nothing. */
  quietBelow: 40,
  /** From here green tests are a good moment to compact. */
  compactAt: 60,
  /** From here it insists, before auto-compaction picks the moment. */
  urgentAt: 80,
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
  /** How often the band re-reads the engine's figures while nothing else does. */
  refreshMs: 60_000,
  /** Rows a section of the report lists at most. */
  reportRows: 6,
} as const

export const COMPACT_INSTRUCTIONS =
  'Conservá: la tarea en curso y su objetivo, las decisiones tomadas y su porqué, ' +
  'los archivos modificados y su estado, los tests y comandos corridos con su resultado, ' +
  'y lo pendiente. Descartá: salidas largas de herramientas, exploraciones descartadas ' +
  'y el contenido de archivos ya leídos.'

/** The part of a breakdown the report reads. */
export type Breakdown = Pick<SessionContextBreakdown, 'categories' | 'mcpTools' | 'memoryFiles'> &
  Partial<Pick<SessionContextBreakdown, 'skills'>>

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
export const adviceFor = ({ percent, cut, isIdle, hidden }: Signals): AdviceKind | null => {
  if (percent === null || percent < LIMITS.quietBelow) {
    return null
  }

  const kind = pressingOf(percent, cut, isIdle)

  return kind === hidden ? null : kind
}

const pressingOf = (percent: number, cut: Cut | null, isIdle: boolean): AdviceKind | null => {
  if (percent >= LIMITS.urgentAt) {
    return 'urgent'
  }

  if (isIdle) {
    return 'idle'
  }

  if (cut === 'commit') {
    return 'commit'
  }

  return cut === 'tests' && percent >= LIMITS.compactAt ? 'tests' : null
}

/** What became of a command written to the prompt box. */
export type FillOutcome = 'written' | 'no-box' | 'refused'

/**
 * Reads a prompt fill's answer. Only `no_composer` says no box exists, so only
 * then may the mod run the command for the person; any other refusal is unknown.
 */
export const afterFill = (filled: {
  isFilled: boolean
  refusal?: 'no_composer' | 'dialog'
}): FillOutcome => {
  if (filled.isFilled) {
    return 'written'
  }

  return filled.refusal === 'no_composer' ? 'no-box' : 'refused'
}

/**
 * Whether an advice also offers /clear: only where the person may be changing subject,
 * after a commit or a long pause. The mod cannot tell, so it never recommends it.
 */
export const offersClear = (kind: AdviceKind): boolean => kind === 'idle' || kind === 'commit'

/** The line the band shows for an advice: the command it recommends, then why. */
export const messageOf = (kind: AdviceKind, percent: number): string => {
  switch (kind) {
    case 'urgent':
      return `Recomendado: /compact. El contexto está al ${percent}% y conviene compactar ahora, antes de la compactación automática.`
    case 'idle':
      return `Recomendado: /compact. Pausa larga con el contexto al ${percent}%: la caché probablemente venció y el próximo turno lo paga completo. Si cambiás de tema, usá /clear.`
    case 'commit':
      return `Recomendado: /compact. Commit hecho con el contexto al ${percent}%: es un buen corte. Si cambiás de tema, usá /clear.`
    case 'tests':
      return `Recomendado: /compact. Tests en verde con el contexto al ${percent}%: es un buen corte para compactar.`
  }
}

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
    context: gaugeOf('ctx', context.percent, LIMITS.compactAt, LIMITS.urgentAt),
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
        .concat(figures.cost ?? [])
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

/** Cells each gauge's bar takes in a band `columns` wide, so three gauges and the cost fit a row. */
export const barCellsFor = (columns: number): number => (columns >= 100 ? 14 : columns >= 70 ? 8 : 5)

/** How many of a bar's `cells` are filled at `percent`; any use at all fills one. */
export const filledCells = (percent: number, cells: number): number =>
  Math.min(cells, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * cells)))

const top = <T>(rows: readonly T[], tokensOf: (row: T) => number): T[] =>
  [...rows].sort((a, b) => tokensOf(b) - tokensOf(a)).slice(0, LIMITS.reportRows)

const section = (title: string, rows: readonly string[]): string[] =>
  rows.length === 0 ? [] : ['', title, ...rows.map(row => `  ${row}`)]

const connectorRows = (tools: Breakdown['mcpTools']): string[] => {
  const loaded = new Map<string, { tokens: number; tools: number }>()
  const deferred = new Set<string>()

  for (const tool of tools) {
    if (!tool.isLoaded) {
      deferred.add(tool.serverName)
      continue
    }

    const sum = loaded.get(tool.serverName) ?? { tokens: 0, tools: 0 }
    loaded.set(tool.serverName, { tokens: sum.tokens + tool.tokens, tools: sum.tools + 1 })
  }

  const waiting = [...deferred].filter(name => !loaded.has(name)).length
  const rows = top([...loaded], ([, sum]) => sum.tokens).map(
    ([name, sum]) =>
      `${name}: ${formatCount(sum.tokens)} (${sum.tools} ${sum.tools === 1 ? 'herramienta' : 'herramientas'})`,
  )

  return waiting === 0
    ? rows
    : [
        ...rows,
        `+ ${waiting} ${waiting === 1 ? 'conector' : 'conectores'} con esquemas diferidos (no ocupan hasta usarse)`,
      ]
}

const windowRow = ({ context, cost }: SessionUsage): string => {
  const spent = cost === undefined ? '' : ` · US$${cost.usd.toFixed(2)}`

  return context.tokens === undefined || context.percent === undefined
    ? `Contexto: sin datos todavía (ventana de ${formatCount(context.window)} tokens)${spent}`
    : `Contexto: ${formatCount(context.tokens)} de ${formatCount(context.window)} tokens (${context.percent}%)${spent}`
}

/** A rate-limit window as the engine last reported it, to its decimal, with its reset. */
const limitRow = (limit: SessionUsage['rateLimits'][number], nowMs: number): string => {
  const reset = limit.resetsAt === undefined ? null : resetIn(limit.resetsAt, nowMs)
  const used = String(limit.percentUsed).replace('.', ',')

  return `${windowLabelOf(limit.kind)}: ${used}%${reset === null ? '' : ` (se reinicia ${reset})`}`
}

/** The /ahorro report: where the window goes and what the session spent it on. */
export const reportOf = (
  usage: SessionUsage,
  breakdown: Breakdown | undefined,
  ledger: Ledger,
  nowMs: number,
): string => {
  const repeated = Object.entries(ledger.fullReads).filter(([, times]) => times > 1)
  const spent = [
    ...section(
      'Límites de uso (última respuesta del modelo):',
      usage.rateLimits.map(limit => limitRow(limit, nowMs)),
    ),
    ...section(
      'Salidas grandes en esta conversación (estimado):',
      top(ledger.bigOutputs, one => one.tokens).map(
        one => `${one.tool} ${one.target}: ~${formatCount(one.tokens)}`,
      ),
    ),
    ...section(
      'Archivos leídos enteros más de una vez:',
      top(repeated, ([, times]) => times).map(([path, times]) => `${baseName(path)} ×${times}`),
    ),
  ]

  if (breakdown === undefined) {
    return [windowRow(usage), '', 'Desglose: sin datos en esta sesión.', ...spent].join('\n')
  }

  const used = breakdown.categories.filter(row => row.kind === 'used' && row.tokens > 0)
  const skills = breakdown.skills

  return [
    windowRow(usage),
    ...section(
      'Qué ocupa lugar (tokens estimados):',
      top(used, row => row.tokens).map(row => `${row.name}: ${formatCount(row.tokens)}`),
    ),
    ...section('Conectores con herramientas cargadas:', connectorRows(breakdown.mcpTools)),
    ...(skills === undefined
      ? []
      : ['', `Skills: ${skills.includedSkills} listadas, ${formatCount(skills.tokens)}`]),
    ...section(
      'Archivos de memoria:',
      top(breakdown.memoryFiles, file => file.tokens).map(
        file => `${baseName(file.path)} (${file.type}): ${formatCount(file.tokens)}`,
      ),
    ),
    ...spent,
  ].join('\n')
}
