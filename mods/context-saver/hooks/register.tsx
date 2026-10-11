import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallInput } from 'claude-code'

import {
  COMPACT_INSTRUCTIONS,
  LIMITS,
  adviceFor,
  afterFill,
  barCellsFor,
  baseName,
  cutOf,
  estimateTokens,
  figuresOf,
  filledCells,
  formatCount,
  messageOf,
  reportOf,
  statusTextOf,
  windowLabelOf,
} from './advisor'
import type { AdviceKind, Gauge, Level, Ledger, Signals } from '../types'

const QUIET: Signals = { percent: null, cut: null, isIdle: false, hidden: null }
const EMPTY: Ledger = { bigOutputs: [], fullReads: {} }

const signals = atom({ plugin: 'context-saver', key: 'signals' } as const, QUIET)
const ledger = atom({ plugin: 'context-saver', key: 'ledger' } as const, EMPTY)
const figures = atom({ plugin: 'context-saver', key: 'figures' } as const, null)

/**
 * Raw colours, not theme keys: the desktop surface paints a theme key it does not know
 * in its own muted colour, so a level drawn by key came out grey there.
 */
const LEVEL_COLORS: Readonly<Record<Level, string>> = {
  ok: '#4ade80',
  warn: '#fbbf24',
  danger: '#f87171',
}
/** Labels and the cost. */
const MUTED = '#9ca3af'
/** The part of a bar not used yet. */
const TRACK = '#4b5563'

/** A hidden urgent advice stays hidden; any other is shown again at the next cut. */
const hiddenAfterNews = (hidden: AdviceKind | null): AdviceKind | null =>
  hidden === 'urgent' ? 'urgent' : null

/** What a tool call acted on, as short as the toast and the report need it. */
const targetOf = (e: ToolCallInput): string => {
  if (e.tool === 'Read') {
    return baseName(e.file_path)
  }

  return e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command.slice(0, 40) : ''
}

const isWholeRead = (e: ToolCallInput): e is ToolCallInput & { tool: 'Read' } =>
  e.tool === 'Read' && e.offset === undefined && e.limit === undefined && e.pages === undefined

/** The wait that marks a long pause; lost on a reload, as every timer is. */
let idleTimer: Timer | undefined
/** Re-reads the engine's figures while nothing else does; lost on a reload too. */
let refreshTimer: Timer | undefined
/** The rate-limit windows already announced, so each is said once. */
const warnedWindows = new Set<string>()
/** Whether the band has asked to be drawn: where it never does, the status line stands in. */
let hasBand = false
/** The status line as last set, so it is set again only when it changes; null before the first. */
let lastStatus: string | undefined | null = null

const setStatus = ($: EngineInterface, text: string | undefined) => {
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
}

const stopIdleTimer = () => {
  idleTimer?.cancel()
  idleTimer = undefined
}

/** The conversation was compacted or cleared: nothing seen so far still holds. */
const startOver = async ($: EngineInterface) => {
  stopIdleTimer()
  await update($, signals, () => QUIET)
  await update($, ledger, () => EMPTY)
  await update($, figures, () => null)
  setStatus($, undefined)
}

/**
 * Reads the engine's figures: gauges, advice, rate limits. Costs no tokens, so it runs
 * wherever the figures may have moved; state is written only when they did.
 */
const refresh = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const percent = usage.context.percent ?? null
  const shown = figuresOf(usage)

  if (JSON.stringify(await read($, figures)) !== JSON.stringify(shown)) {
    await update($, figures, () => shown)
  }

  if ((await read($, signals)).percent !== percent) {
    await update($, signals, now => ({ ...now, percent }))
  }

  setStatus($, hasBand ? undefined : statusTextOf(shown))

  for (const limit of usage.rateLimits) {
    const isNear = limit.percentUsed >= LIMITS.rateLimitWarn

    if (isNear && !warnedWindows.has(limit.kind)) {
      $.ui.toast(`Límite de uso ${windowLabelOf(limit.kind)} al ${Math.round(limit.percentUsed)}%.`, {
        timeoutMs: 8000,
      })
    }

    if (isNear) {
      warnedWindows.add(limit.kind)
    } else {
      warnedWindows.delete(limit.kind)
    }
  }
}

const noteCut = async ($: EngineInterface, e: ToolCallInput) => {
  const isShell = e.tool === 'Bash' || e.tool === 'PowerShell'
  const cut = isShell && e.run_in_background !== true ? cutOf(e.command) : null

  if (cut !== null) {
    await update($, signals, now => ({
      ...now,
      cut: now.cut === 'commit' ? 'commit' : cut,
      hidden: hiddenAfterNews(now.hidden),
    }))
  }
}

const noteBigOutput = async ($: EngineInterface, e: ToolCallInput, text: string) => {
  const tokens = estimateTokens(text)

  if (tokens < LIMITS.bigOutputTokens) {
    return
  }

  const tool = String(e.tool)
  const target = targetOf(e)
  await update($, ledger, now => ({
    ...now,
    bigOutputs: [...now.bigOutputs, { tool, target, tokens }].slice(-50),
  }))
  $.ui.toast(
    `${[tool, target].filter(Boolean).join(' ')} metió ~${formatCount(tokens)} tokens al contexto.`,
    { timeoutMs: 8000 },
  )
}

const noteWholeRead = async ($: EngineInterface, e: ToolCallInput) => {
  if (!isWholeRead(e)) {
    return
  }

  const path = e.file_path
  const times = ((await read($, ledger)).fullReads[path] ?? 0) + 1
  await update($, ledger, now => ({ ...now, fullReads: { ...now.fullReads, [path]: times } }))

  if (times === LIMITS.repeatedReads) {
    $.ui.toast(`${baseName(path)} ya se leyó entero ${times} veces en esta conversación.`, {
      timeoutMs: 8000,
    })
  }
}

const compact = async ($: EngineInterface) => {
  const outcome = afterFill(await $.prompt.fill({ text: `/compact ${COMPACT_INSTRUCTIONS}` }))

  if (outcome === 'written') {
    return
  }

  if (outcome === 'refused') {
    $.ui.toast('No pude escribir en el prompt. Escribí /compact para compactar.')

    return
  }

  try {
    const done = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })

    if (done.skip === undefined) {
      await startOver($)
    } else {
      $.ui.toast(`No se compactó: ${done.skip}`)
    }
  } catch {
    $.ui.toast('No se pudo compactar ahora. Probá con /compact cuando termine el turno.')
  }
}

const clear = async ($: EngineInterface) => {
  const outcome = afterFill(await $.prompt.fill({ text: '/clear' }))

  if (outcome !== 'written') {
    $.ui.toast('Escribí /clear para limpiar la conversación.', { timeoutMs: 8000 })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ahorro',
      description: 'Muestra qué ocupa el contexto y en qué lo gastó esta conversación.',
    })
    await refresh($)
    refreshTimer?.cancel()
    refreshTimer = $.clock.every(LIMITS.refreshMs, () => {
      void refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'ahorro' }, async $ => {
    const usage = await $.session.usage({ breakdown: 'summary' })

    return {
      text: reportOf(usage, usage.context.breakdown, await read($, ledger), await $.clock.now()),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    stopIdleTimer()
    await update($, signals, now => ({
      ...now,
      cut: null,
      isIdle: false,
      hidden: hiddenAfterNews(now.hidden),
    }))
    await refresh($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isMainLoop = e.agentId === undefined

    if (!isMainLoop || ran.deny !== undefined) {
      return ran
    }

    if (ran.isError !== true) {
      await noteCut($, e)
      await noteWholeRead($, e)
    }

    await noteBigOutput($, e, ran.text ?? '')
    await refresh($)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) {
      return done
    }

    await refresh($)
    stopIdleTimer()
    idleTimer = $.clock.after(LIMITS.idleMs, () => {
      void update($, signals, now => ({ ...now, isIdle: true }))
    })

    return done
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    const isMainLoop = e.agentId === undefined

    if (isMainLoop && e.trigger !== 'precompute' && compacted.skip === undefined) {
      await startOver($)
    }

    return compacted
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await startOver($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    hasBand = true
    const now = await read($, signals)
    const shown = await read($, figures)

    if (e.props.hasSurvey || shown === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const { percent } = now
    const kind = e.props.isWorking ? null : adviceFor(now)
    const cells = barCellsFor(e.props.bodyColumns)

    // A muted label, one line coloured up to what is used, and the percentage in bold;
    // at the danger level the whole gauge takes the colour.
    const gauge = (one: Gauge) => {
      const used = filledCells(one.percent, cells)
      const color = LEVEL_COLORS[one.level]
      const isDanger = one.level === 'danger'

      return (
        <Box columnGap={1}>
          <Text color={isDanger ? color : MUTED}>{one.label}</Text>
          <Text>
            {used > 0 && <Text color={color}>{'━'.repeat(used)}</Text>}
            {used < cells && <Text color={TRACK}>{'━'.repeat(cells - used)}</Text>}
          </Text>
          <Text bold {...(isDanger ? { color } : {})}>{`${one.percent}%`}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box columnGap={3}>
          {gauge(shown.context)}
          {shown.limits.map(limit => gauge(limit))}
          {shown.cost !== null && <Text color={MUTED}>{shown.cost}</Text>}
        </Box>
        {kind !== null && percent !== null && (
          <Box flexDirection="column">
            <Text color={kind === 'urgent' ? LEVEL_COLORS.danger : MUTED}>{messageOf(kind, percent)}</Text>
            <Box columnGap={1}>
              <Button key="compact" label="/compact" hotkey="1" variant="primary" onPress={() => void compact($)} />
              <Button key="clear" label="/clear" hotkey="2" onPress={() => void clear($)} />
              <Button
                key="hide"
                label="Ocultar"
                hotkey="0"
                onPress={() => void update($, signals, seen => ({ ...seen, hidden: kind }))}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
