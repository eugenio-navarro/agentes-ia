import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionRateLimit,
  SessionUsage,
  Timer,
  ToolCallInput,
} from 'claude-code'

import {
  COMPACT_INSTRUCTIONS,
  EMPTY_LEDGER,
  LIMITS,
  QUIET_SIGNALS,
  TOPIC_SYSTEM,
  adviceFor,
  agentNoted,
  barCellsFor,
  barSvg,
  clipPrompt,
  baseName,
  commandFor,
  costNoteFrom,
  costNoted,
  costTotalOf,
  costTextOf,
  cutOf,
  estimateTokens,
  figuresOf,
  filledCells,
  formatCount,
  isSubstantial,
  isWorthAsking,
  ledgerFrom,
  levelFor,
  percentTextOf,
  readingFrom,
  reportBlocks,
  reportOf,
  rowCellsOf,
  signalsFrom,
  statusTextOf,
  topicAnswer,
  topicInstructions,
  topicQuestion,
  windowLabelOf,
  windowsNow,
  withoutName,
} from './advisor'
import type { CostNote } from './advisor'
import type { AdviceKind, Gauge, Level, Ledger, Signals } from '../types'

const QUIET = QUIET_SIGNALS
const IGNORE_LABEL = 'Ignorar'
const PLUGIN = 'context-saver'
// Where the usage windows are kept across sessions; what this module last kept there and
// when; and when this process last had them fresh from a response (0, not yet).
const WINDOWS_KEY = 'windows'
let savedWindows = ''
let keptAt = 0
let ownAt = 0
// The session's price is kept under a key of its own, so one session's writes never undo
// another's: the key and note this module holds, what it last wrote, and when (null, never).
const COST_PREFIX = 'cost:'
let costKey: string | null = null
let costNote: CostNote | null = null
let costKept = ''
let costKeptAt: number | null = null
const EMPTY = EMPTY_LEDGER

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

/** The waits that mark a break and then a long pause; lost on a reload, as every timer is. */
let pauseTimers: Timer[] = []
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

const stopPauseTimers = () => {
  pauseTimers.forEach(timer => timer.cancel())
  pauseTimers = []
}

/** Starts counting the pause after a turn: a break first, then long enough for the cache to lapse. */
const startPauseTimers = ($: EngineInterface) => {
  stopPauseTimers()
  pauseTimers = [
    $.clock.after(LIMITS.settledMs, () => {
      void update($, signals, (now): Signals => ({ ...now, pause: 'short' }))
    }),
    $.clock.after(LIMITS.idleMs, () => {
      void update($, signals, (now): Signals => ({ ...now, pause: 'long' }))
    }),
  ]
}

const EDITS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

/** A file changed after the cut: the work is in progress again, so the cut no longer holds. */
const noteEdit = async ($: EngineInterface, e: ToolCallInput) => {
  if (EDITS.includes(String(e.tool)) && (await read($, signals)).cut !== null) {
    await update($, signals, now => ({ ...now, cut: null }))
  }
}

/** The conversation was compacted or cleared: nothing seen so far still holds. */
const startOver = async ($: EngineInterface) => {
  stopPauseTimers()
  await update($, signals, () => QUIET)
  // What the detection and the agents spent is the session's, not the conversation's: it
  // outlives a compaction.
  await update($, ledger, now => ({
    ...EMPTY,
    classifier: ledgerFrom(now).classifier,
    agents: ledgerFrom(now).agents,
    windows: ledgerFrom(now).windows,
  }))
  await update($, figures, () => null)
  setStatus($, undefined)
}

/**
 * The engine's figures with the price of the whole session. The engine counts from when its
 * process started, so after a restart it reads from zero: what earlier runs reached is kept
 * across sessions and added back.
 */
const withWholeCost = async <Usage extends SessionUsage>($: EngineInterface, reported: Usage): Promise<Usage> => {
  if (reported.cost === undefined) {
    return reported
  }

  const nowMs = await $.clock.now()
  const key = `${COST_PREFIX}${await $.session.id()}`

  // The first reading, or a /clear gave the session another id.
  if (key !== costKey) {
    costKey = key
    costNote = costNoteFrom(await $.store.get(key).catch(() => undefined))
    costKept = costNote === null ? '' : `${costNote.base}:${costNote.last}`
  }

  const note = costNoted(costNote, reported.cost.usd, nowMs)
  const text = `${note.base}:${note.last}`
  costNote = note

  if (text !== costKept && (costKeptAt === null || nowMs - costKeptAt >= LIMITS.costKeepMs)) {
    costKept = text
    costKeptAt = nowMs
    await $.store.set(key, note).catch(() => undefined)
  }

  return { ...reported, cost: { ...reported.cost, usd: costTotalOf(note) } }
}

/** Forgets the price of sessions not seen for a long time, so what is kept does not grow for ever. */
const forgetOldCosts = async ($: EngineInterface) => {
  const nowMs = await $.clock.now()
  const keys = (await $.store.keys().catch(() => [])).filter(key => key.startsWith(COST_PREFIX))

  for (const key of keys) {
    const note = costNoteFrom(await $.store.get(key).catch(() => undefined))

    if (key !== costKey && (note === null || nowMs - note.at > LIMITS.costForgetMs)) {
      await $.store.delete(key).catch(() => undefined)
    }
  }
}

/**
 * The usage windows to show now and which are in doubt. `isFresh` says a response has just
 * come, so what the engine reports is of this moment: only then is it kept for every session.
 */
const readWindows = async ($: EngineInterface, reported: SessionRateLimit[], isFresh: boolean) => {
  const nowMs = await $.clock.now()

  if (isFresh && reported.length > 0) {
    ownAt = nowMs
  }

  const noted = ledgerFrom(await read($, ledger)).windows
  const stored = readingFrom(await $.store.get(WINDOWS_KEY).catch(() => undefined))
  // With nothing kept, what this session noted before stands in for it, its time unknown.
  const kept = stored.windows.length > 0 ? stored : { at: 0, windows: noted }
  const now = windowsNow({ at: ownAt, windows: reported }, kept, nowMs)

  if (JSON.stringify(now.windows) !== JSON.stringify(noted)) {
    await update($, ledger, was => ({ ...ledgerFrom(was), windows: now.windows }))
  }

  // Kept when it changes, and at most once a minute while it does not: other sessions read its time.
  const isNews = JSON.stringify(now.windows) !== savedWindows || nowMs - keptAt >= LIMITS.refreshMs

  if (isFresh && reported.length > 0 && isNews) {
    savedWindows = JSON.stringify(now.windows)
    keptAt = nowMs
    await $.store.set(WINDOWS_KEY, { at: nowMs, windows: now.windows }).catch(() => undefined)
  }

  return now
}

/**
 * Reads the engine's figures: gauges, advice, rate limits. Costs no tokens, so it runs
 * wherever the figures may have moved; state is written only when they did.
 */
const refresh = async ($: EngineInterface, isFresh = false) => {
  const reported = await withWholeCost($, await $.session.usage())
  const windows = await readWindows($, reported.rateLimits, isFresh)
  const usage = { ...reported, rateLimits: windows.windows }
  const percent = usage.context.percent ?? null
  const shown = figuresOf(usage, windows.stale)

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

/** Notes a subagent's turn: its tokens never show in this conversation's context, only in /uso. */
const noteAgent = async ($: EngineInterface, id: string, usage: Parameters<typeof agentNoted>[2]) => {
  const isNoted = ledgerFrom(await read($, ledger)).agents.some(one => one.id === id)
  // What it is and what for, asked once while the engine still lists it; the call is free.
  const known = isNoted ? undefined : (await $.agent.list().catch(() => [])).find(one => one.id === id)

  await update($, ledger, now => ({
    ...ledgerFrom(now),
    agents: agentNoted(ledgerFrom(now).agents, id, usage, known),
  }))
}

/**
 * Runs the command the person pressed, as if they had typed it; pressing is their decision.
 * What follows a compaction or a clear is noted by the hooks on those events.
 */
const runCommand = async ($: EngineInterface, command: 'compact' | 'clear', args?: string) => {
  try {
    await $.command.run({ command, ...(args === undefined ? {} : { args }) })
  } catch {
    $.ui.toast(`No pude ejecutar /${command} ahora. Escribilo en el prompt.`, { timeoutMs: 8000 })
  }
}

/**
 * Asks the small model whether a prompt changes the subject, only where the answer can
 * matter, and notes it. The answer never acts: it only decides what the band recommends.
 */
const noteTopic = async ($: EngineInterface, text: string) => {
  if (!isSubstantial(text)) {
    return
  }

  const { prompts, classifier } = ledgerFrom(await read($, ledger))
  const { percent } = await read($, signals)
  const remembered = (list: readonly string[]) => [...list, clipPrompt(text)].slice(-LIMITS.topicHistory)

  if (!isWorthAsking({ text, percent, known: prompts.length, asked: classifier.asked })) {
    await update($, ledger, now => ({ ...now, prompts: remembered(now.prompts) }))

    return
  }

  const reply = await $.model.complete({
    model: 'haiku',
    system: TOPIC_SYSTEM,
    prompt: topicQuestion(prompts, text),
    maxTokens: 16,
    effort: 'low',
    timeoutMs: 15_000,
  })
  const answer = reply.isAnswered ? topicAnswer(reply.text) : null
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = reply.usage
  const tokens = input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens

  await update($, ledger, now => ({
    ...now,
    // A new subject is what later prompts are compared with; the old one is left behind.
    prompts: answer === 'new' ? [clipPrompt(text)] : remembered(now.prompts),
    classifier: { asked: now.classifier.asked + 1, tokens: now.classifier.tokens + tokens },
  }))

  if (answer !== null) {
    await update($, signals, (now): Signals => ({ ...now, topic: answer === 'new' ? clipPrompt(text) : null }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload keeps the state an earlier version wrote: bring it to this version first.
    await update($, signals, stored => signalsFrom(stored))
    await update($, ledger, stored => ledgerFrom(stored))
    await $.command.register({
      name: 'uso',
      description: 'Uso del contexto y de tus límites, y qué ocupa lugar en esta conversación.',
    })
    await refresh($)
    await forgetOldCosts($)
    refreshTimer?.cancel()
    refreshTimer = $.clock.every(LIMITS.refreshMs, () => {
      void refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'uso' }, async $ => {
    const reported = await withWholeCost($, await $.session.usage({ breakdown: 'summary' }))
    const windows = await readWindows($, reported.rateLimits, false)
    const spent = ledgerFrom(await read($, ledger))
    const usage = { ...reported, rateLimits: windows.windows }

    return { text: reportOf(usage, reported.context.breakdown, spent, await $.clock.now(), windows) }
  })

  on('prompt.submit', async ($, e, next) => {
    stopPauseTimers()
    await update($, signals, (now): Signals => ({
      ...now,
      cut: null,
      pause: 'none',
      hidden: hiddenAfterNews(now.hidden),
    }))
    await refresh($)

    // The prompt goes on its way first: asking about its subject never holds it back.
    const entered = await next(e)

    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      await noteTopic($, e.text)
    }

    return entered
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isMainLoop = e.agentId === undefined

    if (!isMainLoop || ran.deny !== undefined) {
      return ran
    }

    if (ran.isError !== true) {
      await noteEdit($, e)
      await noteCut($, e)
      await noteWholeRead($, e)
    }

    await noteBigOutput($, e, ran.text ?? '')
    await refresh($, true)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    const { agentId, usage } = e

    if (agentId !== undefined) {
      await noteAgent($, agentId, usage)

      return done
    }

    await refresh($, true)
    startPauseTimers($)

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
    const now = signalsFrom(await read($, signals))
    const shown = await read($, figures)

    if (e.props.hasSurvey || shown === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // A terminal has no vector element: there the bar is drawn in block characters.
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const kind = e.props.isWorking ? null : adviceFor(now)
    const command = kind === null ? null : commandFor(kind)
    const buttons = command === null ? [] : [`/${command}`, IGNORE_LABEL]
    // The gaps stay as they are: the room the row leaves goes to the bars.
    const cells = barCellsFor(e.props.bodyColumns, rowCellsOf(shown, buttons), 1 + shown.limits.length)

    // A muted label, a thick rounded bar coloured up to what is used, and the percentage
    // in bold; at the danger level the whole gauge takes the colour.
    const gauge = (one: Gauge) => {
      const used = filledCells(one.percent, cells)
      // A reading in doubt loses its colour: muted, and its percentage written as approximate.
      const isStale = one.isStale === true
      const color = isStale ? MUTED : LEVEL_COLORS[one.level]
      const isDanger = !isStale && one.level === 'danger'

      return (
        <Box columnGap={LIMITS.innerGapCells} alignItems="center" flexShrink={0}>
          <Text color={isDanger ? color : MUTED}>{one.label}</Text>
          {Svg === null ? (
            <Text>
              {used > 0 && <Text color={color}>{'█'.repeat(used)}</Text>}
              {used < cells && <Text color={TRACK}>{'█'.repeat(cells - used)}</Text>}
            </Text>
          ) : (
            <Svg
              source={barSvg(one.percent, color, TRACK, cells * LIMITS.cellPx, LIMITS.barHeightPx)}
              alt={percentTextOf(one)}
              width={cells * LIMITS.cellPx}
              height={LIMITS.barHeightPx}
            />
          )}
          <Text bold {...(isDanger || isStale ? { color } : {})}>
            {percentTextOf(one)}
          </Text>
        </Box>
      )
    }

    // Nothing in the row shrinks, so a narrow band wraps it instead of drawing one part over another.
    // The row spans the band and its parts sit together in the middle, each line of a wrapped row too.
    // One row: the gauges, then, only when there is something to recommend, the command
    // itself as the one button to press, which runs it, and Ignorar beside it.
    return (
      <Box columnGap={LIMITS.rowGapCells} alignItems="center" flexWrap="wrap" width="100%" justifyContent="center">
        {gauge(shown.context)}
        {shown.limits.map(limit => gauge(limit))}
        {shown.cost !== null && (
          <Box flexShrink={0}>
            <Text color={MUTED}>{costTextOf(shown.cost)}</Text>
          </Box>
        )}
        {kind !== null && command !== null && (
          <Box columnGap={LIMITS.innerGapCells} flexShrink={0}>
            <Button
              key={command}
              label={`/${command}`}
              variant="primary"
              onPress={() =>
                void (command === 'clear'
                  ? runCommand($, command)
                  : runCommand(
                      $,
                      command,
                      now.topic !== null && kind === 'topic' ? topicInstructions(now.topic) : COMPACT_INSTRUCTIONS,
                    ))
              }
            />
            <Button
              key="ignore"
              label={IGNORE_LABEL}
              onPress={() =>
                // Ignoring a change of subject settles it: it is not brought up again.
                void update($, signals, seen => ({
                  ...seen,
                  hidden: kind,
                  topic: kind === 'topic' ? null : seen.topic,
                }))
              }
            />
          </Box>
        )}
      </Box>
    )
  })

  // The /uso report, drawn in the transcript with the band's own bars and colours: a title
  // per part, one row per figure. The text it is read from is what the model keeps.
  on('ui.render', { component: 'CommandOutput', props: { command: 'uso' } }, ($, e, next) => {
    if (e.props.isErrored) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg

    const bar = (percent: number, color: string) => {
      const used = filledCells(percent, LIMITS.reportBarCells)

      return Svg === null ? (
        <Text>
          {used > 0 && <Text color={color}>{'█'.repeat(used)}</Text>}
          {used < LIMITS.reportBarCells && (
            <Text color={TRACK}>{'█'.repeat(LIMITS.reportBarCells - used)}</Text>
          )}
        </Text>
      ) : (
        <Svg
          source={barSvg(percent, color, TRACK, LIMITS.reportBarPx, LIMITS.barHeightPx)}
          alt={`${percent}%`}
          width={LIMITS.reportBarPx}
          height={LIMITS.barHeightPx}
        />
      )
    }

    // A label in a column of its own width, so the bars of a part start at the same place.
    const row = (label: string, labelCells: number, percent: number, color: string, detail: string | null) => (
      <Box columnGap={1} alignItems="center">
        <Box width={labelCells} flexShrink={0}>
          <Text color={MUTED}>{label}</Text>
        </Box>
        {bar(percent, color)}
        <Box width={5} flexShrink={0}>
          <Text bold>{`${percent}%`}</Text>
        </Box>
        {detail !== null && <Text color={MUTED}>{detail}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>Uso</Text>
        {reportBlocks(withoutName(e.props.text, PLUGIN)).map(block => {
          switch (block.kind) {
            case 'figure':
              return row(block.label, 10, block.percent, LEVEL_COLORS[levelFor(block.percent)], block.detail)
            case 'share':
              return row(block.label, LIMITS.reportLabelCells, block.percent, MUTED, block.amount)
            case 'fact':
              return (
                <Box columnGap={1}>
                  <Text color={MUTED}>{block.label}</Text>
                  <Text bold>{block.value}</Text>
                </Box>
              )
            case 'detail':
              return (
                <Box columnGap={1}>
                  <Box width={LIMITS.reportLabelCells} flexShrink={0}>
                    <Text color={MUTED}>{block.label}</Text>
                  </Box>
                  <Text>{block.value}</Text>
                </Box>
              )
            case 'agent':
              return (
                <Box columnGap={1}>
                  <Box width={LIMITS.reportLabelCells} flexShrink={0}>
                    <Text color={MUTED}>{block.type}</Text>
                  </Box>
                  <Box width={12} flexShrink={0}>
                    <Text bold>{block.amount}</Text>
                  </Box>
                  <Text>{block.description}</Text>
                </Box>
              )
            case 'title':
              return (
                <Box marginTop={1}>
                  <Text bold>{block.text}</Text>
                </Box>
              )
            case 'note':
              return <Text color={MUTED}>{block.text}</Text>
          }
        })}
      </Box>
    )
  })
}
