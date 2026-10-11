import { describe, expect, test } from 'claude-code/testing'

import {
  adviceFor,
  agentNoted,
  barCellsFor,
  barSvg,
  commandFor,
  cutOf,
  estimateTokens,
  figuresOf,
  filledCells,
  isWorthAsking,
  ledgerFrom,
  levelFor,
  reportBlocks,
  reportOf,
  rowCellsOf,
  resetIn,
  shortCount,
  signalsFrom,
  statusTextOf,
  topicAnswer,
  topicInstructions,
  topicQuestion,
  windowsShown,
  withoutName,
} from '../hooks/advisor'
import type { Figures, Signals } from '../types'

const signals = (over: Partial<Signals>): Signals => ({
  percent: null,
  cut: null,
  pause: 'none',
  hidden: null,
  topic: null,
  ...over,
})

describe('adviceFor', () => {
  test('stays quiet before the first response and under 40%', () => {
    expect(adviceFor(signals({ cut: 'commit', pause: 'long' }))).toBe(null)
    expect(adviceFor(signals({ percent: 39, cut: 'commit', pause: 'long' }))).toBe(null)
  })

  test('takes the work as done once a commit is followed by a break, from 40%', () => {
    expect(adviceFor(signals({ percent: 40, cut: 'commit' })), 'no break yet').toBe(null)
    expect(adviceFor(signals({ percent: 40, cut: 'commit', pause: 'short' }))).toBe('done')
    expect(adviceFor(signals({ percent: 95, cut: 'commit', pause: 'long' })), 'even when full').toBe('done')
  })

  test('takes a natural cut from 60%: a commit or green tests', () => {
    expect(adviceFor(signals({ percent: 59, cut: 'tests' }))).toBe(null)
    expect(adviceFor(signals({ percent: 60, cut: 'tests' }))).toBe('cut')
    expect(adviceFor(signals({ percent: 60, cut: 'commit' }))).toBe('cut')
    expect(adviceFor(signals({ percent: 70, cut: 'tests', pause: 'short' })), 'green tests are not saved work').toBe('cut')
  })

  test('says nothing between 40% and 80% without a cut or a long pause', () => {
    expect(adviceFor(signals({ percent: 79 }))).toBe(null)
    expect(adviceFor(signals({ percent: 79, pause: 'short' }))).toBe(null)
  })

  test('warns after a long pause from 40%, and insists from 80%', () => {
    expect(adviceFor(signals({ percent: 45, pause: 'long' }))).toBe('idle')
    expect(adviceFor(signals({ percent: 80 }))).toBe('urgent')
    expect(adviceFor(signals({ percent: 90, pause: 'long', cut: 'tests' }))).toBe('urgent')
  })

  test('keeps an ignored advice hidden until another one comes', () => {
    expect(adviceFor(signals({ percent: 65, cut: 'tests', hidden: 'cut' }))).toBe(null)
    expect(adviceFor(signals({ percent: 85, cut: 'tests', hidden: 'cut' }))).toBe('urgent')
  })
})

describe('commandFor', () => {
  test('recommends /clear only when the work is saved, /compact otherwise', () => {
    expect((['urgent', 'idle', 'cut', 'done'] as const).map(commandFor)).toEqual([
      'compact',
      'compact',
      'compact',
      'clear',
    ])
  })
})

describe('a change of subject', () => {
  const LONG = 'ahora quiero armar el script de despliegue del servidor'
  const ask = { text: LONG, percent: 50, known: 2, asked: 0 }

  test('is the first thing recommended once detected, from 40%, with a /compact', () => {
    expect(adviceFor(signals({ percent: 50, topic: LONG }))).toBe('topic')
    expect(adviceFor(signals({ percent: 85, topic: LONG })), 'frees more than a plain one').toBe('topic')
    expect(adviceFor(signals({ percent: 39, topic: LONG }))).toBe(null)
    expect(commandFor('topic')).toBe('compact')
  })

  test('is asked about only when the answer can matter', () => {
    expect(isWorthAsking(ask)).toBe(true)
    expect(isWorthAsking({ ...ask, percent: 39 }), 'little to clear').toBe(false)
    expect(isWorthAsking({ ...ask, percent: null }), 'no reading yet').toBe(false)
    expect(isWorthAsking({ ...ask, known: 0 }), 'nothing to compare with').toBe(false)
    expect(isWorthAsking({ ...ask, asked: 30 }), 'the session cap').toBe(false)
    expect(isWorthAsking({ ...ask, text: 'dale, hacelo así' }), 'a short reply').toBe(false)
    expect(isWorthAsking({ ...ask, text: '/compact ahora mismo por favor y gracias' }), 'a command').toBe(false)
  })

  test('is put to the model as the earlier prompts and the new one, each clipped', () => {
    const question = topicQuestion(['uno   con\nespacios', 'x'.repeat(500)], LONG)

    expect(question).toContain('- uno con espacios\n')
    expect(question).toContain('- ' + 'x'.repeat(300) + '\n')
    expect(question).not.toContain('x'.repeat(301))
    expect(question.endsWith('Mensaje nuevo:\n' + LONG)).toBe(true)
  })

  test('is read from a one-word answer, and anything unclear is no answer', () => {
    expect(['NUEVO', ' nuevo.', 'MISMO', 'Mismo'].map(topicAnswer)).toEqual(['new', 'new', 'same', 'same'])
    expect(['no sé', '', 'MISMO, no NUEVO'].map(topicAnswer)).toEqual([null, null, null])
  })

  test('asks the compaction to keep only the new subject', () => {
    expect(topicInstructions(LONG)).toContain(LONG)
    expect(topicInstructions(LONG).startsWith('Cambio de tema')).toBe(true)
  })
})

describe('state kept from an earlier version', () => {
  test('takes the defaults for the fields that version did not have', () => {
    const old = { percent: 50, cut: null, isIdle: true, hidden: null } as never

    expect(signalsFrom(old)).toMatchObject({ percent: 50, pause: 'none', topic: null })
    expect(adviceFor(signalsFrom(old)), 'no advice out of a missing field').toBe(null)
  })

  test('keeps what the ledger held and adds what it lacked', () => {
    const big = { tool: 'Read', target: 'big.ts', tokens: 12_000 }
    const ledger = ledgerFrom({ bigOutputs: [big], fullReads: {} })

    expect(ledger).toEqual({
      bigOutputs: [big],
      fullReads: {},
      prompts: [],
      classifier: { asked: 0, tokens: 0 },
      agents: [],
      windows: [],
    })
    expect(reportOf({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }, undefined, ledger, 0)).toContain('Salidas grandes')
  })

  test('starts from the defaults when nothing is stored', () => {
    expect(signalsFrom(undefined)).toEqual({ percent: null, cut: null, pause: 'none', hidden: null, topic: null })
    expect(ledgerFrom(null).classifier).toEqual({ asked: 0, tokens: 0 })
    expect(ledgerFrom({ bigOutputs: [] }).agents, 'state saved before agents were noted').toEqual([])
    expect(ledgerFrom({ agents: { ids: ['a1'], tokens: 5 } } as never).agents, 'a count, as 0.12.0 kept it').toEqual([])
  })
})

describe('windowsShown', () => {
  const AT = Date.parse('2026-10-11T14:00:00Z')
  const fiveHours = { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-11T14:02:00Z' }
  const week = { kind: 'seven_day', percentUsed: 4 }

  test('shows what the engine reports, in the order first seen', () => {
    expect(windowsShown([fiveHours, week], [], AT)).toEqual([fiveHours, week])
    expect(windowsShown([{ ...week, percentUsed: 5 }, fiveHours], [fiveHours, week], AT)).toEqual([
      fiveHours,
      { ...week, percentUsed: 5 },
    ])
  })

  test('keeps a window the engine left out: as it was until its reset, at 0% after it', () => {
    expect(windowsShown([week], [fiveHours, week], AT), 'before its reset').toEqual([fiveHours, week])
    expect(windowsShown([week], [fiveHours, week], AT + 3 * 60_000), 'after its reset').toEqual([
      { kind: 'five_hour', percentUsed: 0 },
      week,
    ])
    expect(windowsShown([], [week], AT + 3 * 60_000), 'no reset time known').toEqual([week])
  })
})

describe('agentNoted', () => {
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 800 }
  const known = { type: 'Explore', description: '  buscar usos\nde X | Y  ' }

  test('notes an agent once however many turns it runs, and adds up every token its turns processed', () => {
    const once = agentNoted([], 'a1', usage, known)
    const twice = agentNoted(once, 'a1', usage, undefined)

    expect(once).toEqual([{ id: 'a1', type: 'Explore', description: 'buscar usos de X / Y', tokens: 5000 }])
    expect(twice).toEqual([{ id: 'a1', type: 'Explore', description: 'buscar usos de X / Y', tokens: 10_000 }])
  })

  test('notes an agent the engine says nothing about, and a turn with no usage', () => {
    expect(agentNoted([], 'a2', undefined, undefined)).toEqual([
      { id: 'a2', type: 'agente', description: '', tokens: 0 },
    ])
  })
})

describe('withoutName', () => {
  test("drops the plugin's name the engine puts before a command's text, and nothing else", () => {
    expect(withoutName('context-saver: Contexto  sin datos', 'context-saver')).toBe('Contexto  sin datos')
    expect(withoutName('Contexto  sin datos', 'context-saver')).toBe('Contexto  sin datos')
    expect(withoutName('Precio de la sesión: $1.00', 'context-saver')).toBe('Precio de la sesión: $1.00')
  })
})

describe('reportBlocks', () => {
  test('reads the report back into what each line is', () => {
    const text = [
      'Contexto  ██████████░░░░░░░░░░  48% · 476k de 1M tokens',
      '7 días    █████████████████░░░  85%',
      'Precio de la sesión: $16.45',
      '',
      'Qué ocupa el contexto',
      '• Instrucciones y memoria: 10k (2%)',
      '',
      'Detalle del gasto',
      '• Conectores más pesados: browser 11k · gmail 1k',
    ].join('\n')

    expect(reportBlocks(text)).toEqual([
      { kind: 'figure', label: 'Contexto', percent: 48, detail: '476k de 1M tokens' },
      { kind: 'figure', label: '7 días', percent: 85, detail: null },
      { kind: 'fact', label: 'Precio de la sesión', value: '$16.45' },
      { kind: 'title', text: 'Qué ocupa el contexto' },
      { kind: 'share', label: 'Instrucciones y memoria', amount: '10k', percent: 2 },
      { kind: 'title', text: 'Detalle del gasto' },
      { kind: 'detail', label: 'Conectores más pesados', value: 'browser 11k · gmail 1k' },
    ])
  })

  test('reads the agents part: a line an agent, the rest summed up, or a note when there were none', () => {
    const text = ['Agentes', '• Explore | buscar: usos | 80k tokens', '• agente |  | 0 tokens', 'y 2 más: 3k tokens']

    expect(reportBlocks(text.join('\n'))).toEqual([
      { kind: 'title', text: 'Agentes' },
      { kind: 'agent', type: 'Explore', description: 'buscar: usos', amount: '80k tokens' },
      { kind: 'agent', type: 'agente', description: '', amount: '0 tokens' },
      { kind: 'fact', label: 'y 2 más', value: '3k tokens' },
    ])
    expect(reportBlocks('Agentes\nNo se usaron agentes en esta sesión.')[1]).toEqual({
      kind: 'note',
      text: 'No se usaron agentes en esta sesión.',
    })
  })

  test('reads a report with no reading as a note, and colours a figure by the usual levels', () => {
    expect(reportBlocks('Contexto  sin datos todavía')).toEqual([
      { kind: 'note', text: 'Contexto  sin datos todavía' },
    ])
    expect([59, 60, 80].map(levelFor)).toEqual(['ok', 'warn', 'danger'])
  })
})

describe('cutOf', () => {
  test('reads a commit', () => {
    expect(cutOf('git commit -m "feat: x"')).toBe('commit')
    expect(cutOf('git add . && git commit -m x')).toBe('commit')
  })

  test('reads a test run', () => {
    for (const command of ['npm test', 'pnpm run test', 'pytest -q', 'go test ./...', './gradlew test']) {
      expect(cutOf(command), command).toBe('tests')
    }
  })

  test('reads nothing in other commands', () => {
    for (const command of ['git status', 'git log --grep commit', 'npm install', 'ls tests']) {
      expect(cutOf(command), command).toBe(null)
    }
  })
})

describe('estimateTokens', () => {
  test('counts about four characters to a token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('x'.repeat(40_000))).toBe(10_000)
  })
})

describe('rowCellsOf', () => {
  const figures: Figures = {
    context: { label: 'contexto', percent: 78, level: 'warn' },
    limits: [
      { label: '5 h', percent: 0, level: 'ok' },
      { label: '7 días', percent: 85, level: 'danger' },
    ],
    cost: '$16.45',
  }

  test('counts every text, gap and button of the row, but not the bars', () => {
    expect(rowCellsOf(figures, [])).toBe(55)
    expect(rowCellsOf(figures, ['/compact', 'Ignorar'])).toBe(81)
  })

  test('counts a percentage at its widest, so a bar keeps its length as the figure grows', () => {
    expect(rowCellsOf({ ...figures, context: { ...figures.context, percent: 100 } }, [])).toBe(55)
  })

  test('counts no price where there is none', () => {
    expect(rowCellsOf({ ...figures, cost: null }, [])).toBe(39)
  })
})

describe('barCellsFor', () => {
  test('shares the room the row leaves between its bars', () => {
    expect(barCellsFor(93, 55, 3)).toBe(12)
  })

  test('keeps a bar within what reads as one', () => {
    expect(barCellsFor(93, 81, 3), 'a crowded row').toBe(7)
    expect(barCellsFor(200, 29, 1), 'a row with room to spare').toBe(16)
  })
})

describe('filledCells', () => {
  test('fills as many cells as the share, and never overflows', () => {
    expect(filledCells(0, 8)).toBe(0)
    expect(filledCells(29, 8)).toBe(2)
    expect(filledCells(100, 8)).toBe(8)
    expect(filledCells(140, 8)).toBe(8)
  })

  test('shows one cell for any use at all', () => {
    expect(filledCells(3, 8)).toBe(1)
  })
})

describe('figuresOf', () => {
  test('reads context, rate-limit windows and cost as the band draws them', () => {
    const figures = figuresOf({
      startedAt: 0,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      cost: { usd: 1.234 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 30.4 },
        { kind: 'seven_day', percentUsed: 12 },
      ],
    })

    expect(figures).toEqual({
      context: { label: 'contexto', percent: 42, level: 'ok' },
      limits: [
        { label: '5h', percent: 30, level: 'ok' },
        { label: '7d', percent: 12, level: 'ok' },
      ],
      cost: '$1.23',
    })
  })

  test('colours by level: warn from 60%, danger from 80%', () => {
    const levels = (context: number, window: number) => {
      const figures = figuresOf({
        startedAt: 0,
        context: { window: 200_000, percent: context },
        rateLimits: [{ kind: 'seven_day', percentUsed: window }],
      })

      return [figures?.context.level, figures?.limits[0]?.level]
    }

    expect(levels(59, 59.4)).toEqual(['ok', 'ok'])
    expect(levels(60, 60)).toEqual(['warn', 'warn'])
    expect(levels(80, 80)).toEqual(['danger', 'danger'])
  })

  test('has nothing to draw before the first response, and no cost without a ledger', () => {
    expect(figuresOf({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] })).toBe(null)
    expect(
      figuresOf({ startedAt: 0, context: { window: 200_000, percent: 5 }, rateLimits: [] })?.cost,
    ).toBe(null)
  })
})

const NOW = Date.parse('2026-10-11T14:00:00Z')

describe('resetIn', () => {
  test('says how long until a window resets, in its two largest units', () => {
    expect(resetIn('2026-10-11T14:45:00Z', NOW)).toBe('en 45 min')
    expect(resetIn('2026-10-11T16:13:00Z', NOW)).toBe('en 2 h 13 min')
    expect(resetIn('2026-10-14T18:30:00Z', NOW)).toBe('en 3 d 4 h')
  })

  test('says now for a reset already due, and nothing for a date it cannot read', () => {
    expect(resetIn('2026-10-11T13:00:00Z', NOW)).toBe('ahora')
    expect(resetIn('not a date', NOW)).toBe(null)
  })
})

describe('statusTextOf', () => {
  test('writes the figures as one plain line, for a surface with no band', () => {
    const text = statusTextOf({
      context: { label: 'ctx', percent: 42, level: 'ok' },
      limits: [{ label: '5h', percent: 57, level: 'ok' }],
      cost: '$1.23',
    })

    expect(text).toBe('ctx 42% · 5h 57% · Precio: $1.23')
    expect(statusTextOf(null)).toBe(undefined)
  })
})

describe('shortCount', () => {
  test('writes a token count the way people say it', () => {
    expect([950, 12_345, 475_785, 999_600, 1_000_000, 1_250_000].map(shortCount)).toEqual([
      '950',
      '12k',
      '476k',
      '1M',
      '1M',
      '1,3M',
    ])
  })
})

describe('barSvg', () => {
  test('draws a rounded track with the used part over it', () => {
    const svg = barSvg(50, '#0f0', '#333', 120, 8)

    expect(svg).toContain('width="120" height="8" rx="4" fill="#333"')
    expect(svg).toContain('width="60" height="8" rx="4" fill="#0f0"')
  })

  test('keeps a small use visible as a round dot, fills at most the track, draws none at zero', () => {
    expect(barSvg(1, '#0f0', '#333', 120, 8)).toContain('width="8" height="8" rx="4" fill="#0f0"')
    expect(barSvg(250, '#0f0', '#333', 120, 8)).toContain('width="120" height="8" rx="4" fill="#0f0"')
    expect(barSvg(0, '#0f0', '#333', 120, 8)).not.toContain('#0f0')
  })
})

describe('reportOf', () => {
  const usage = {
    startedAt: 0,
    context: { window: 1_000_000, tokens: 475_785, percent: 48 },
    cost: { usd: 16.45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 90, resetsAt: '2026-10-11T15:11:00Z' },
      { kind: 'seven_day', percentUsed: 84.6 },
    ],
  }
  const row = (name: string, tokens: number, kind: 'used' | 'free' = 'used') => ({
    name,
    tokens,
    color: 'text',
    isDeferred: false,
    kind,
  })
  const breakdown = {
    categories: [
      row('Messages', 400_000),
      row('System tools', 30_000),
      row('MCP tools', 20_000),
      row('Skills', 10_000),
      row('System prompt', 5_000),
      row('Memory files', 5_000),
      row('Free space', 500_000, 'free'),
    ],
    mcpTools: [
      { name: 'mcp__browser__a', serverName: 'browser', tokens: 6_000, isLoaded: true },
      { name: 'mcp__browser__b', serverName: 'browser', tokens: 5_000, isLoaded: true },
      { name: 'mcp__gmail__a', serverName: 'gmail', tokens: 1_000, isLoaded: true },
      { name: 'mcp__drive__a', serverName: 'drive', tokens: 9_000, isLoaded: false },
    ],
  }
  const QUIET = {
    bigOutputs: [],
    fullReads: {},
    prompts: [],
    classifier: { asked: 0, tokens: 0 },
    agents: [],
    windows: [],
  }

  test('opens with one bar per figure: context, each usage window, then the cost', () => {
    const lines = reportOf(usage, breakdown, QUIET, NOW).split('\n')

    expect(lines.slice(0, 4)).toEqual([
      'Contexto  ██████████░░░░░░░░░░  48% · 476k de 1M tokens',
      '5 horas   ██████████████████░░  90% · se reinicia en 1 h 11 min',
      '7 días    █████████████████░░░  85%',
      'Precio de la sesión: $16.45',
    ])
  })

  test('groups what fills the context under four plain names, largest first', () => {
    const text = reportOf(usage, breakdown, QUIET, NOW)

    expect(text).toContain(
      [
        'Qué ocupa el contexto',
        '• Conversación: 400k (85%)',
        '• Herramientas: 50k (11%)',
        '• Skills: 10k (2%)',
        '• Instrucciones y memoria: 10k (2%)',
      ].join('\n'),
    )
    expect(text).not.toContain('Free space')
  })

  test('names the heaviest loaded connectors, and what the conversation spent only when it did', () => {
    const quiet = reportOf(usage, breakdown, QUIET, NOW)
    expect(quiet.includes('\n\nDetalle del gasto\n• Conectores más pesados: browser 11k · gmail 1k\n\nAgentes\n'), 'a part of its own, with its title').toBe(true)
    expect(quiet).not.toContain('drive')
    expect(quiet).not.toContain('Salidas grandes')
    expect(quiet).not.toContain('Releídos')

    const busy = reportOf(
      usage,
      breakdown,
      {
        ...QUIET,
        bigOutputs: [{ tool: 'Read', target: 'big.ts', tokens: 12_000 }],
        fullReads: { 'C:/p/a.ts': 3, 'C:/p/b.ts': 1 },
      },
      NOW,
    )
    expect(busy).toContain('\n• Salidas grandes: Read big.ts ~12k')
    expect(busy).toContain('\n• Releídos enteros: a.ts ×3')
    expect(busy.split('Detalle del gasto').length, 'one title for the whole part').toBe(2)
    expect(busy).not.toContain('b.ts')
  })

  test('lists each agent on a line of its own under a title, heaviest first, and says so when there were none', () => {
    const quiet = reportOf(usage, breakdown, QUIET, NOW)
    expect(quiet.endsWith('\n\nAgentes\nNo se usaron agentes en esta sesión.')).toBe(true)

    const agents = [
      { id: 'a1', type: 'Explore', description: 'buscar usos', tokens: 80_000 },
      { id: 'a2', type: 'software-engineer', description: 'ING: implementar login', tokens: 412_300 },
    ]
    const busy = reportOf(usage, breakdown, { ...QUIET, agents }, NOW)

    expect(
      busy.endsWith(
        '\n\nAgentes\n• software-engineer | ING: implementar login | 412k tokens\n• Explore | buscar usos | 80k tokens',
      ),
    ).toBe(true)
    expect(busy).not.toContain('No se usaron')
  })

  test('lists the six heaviest agents and sums up the rest in one line', () => {
    const agents = Array.from({ length: 8 }, (_, index) => ({
      id: `a${index}`,
      type: 'Explore',
      description: `tarea ${index}`,
      tokens: (index + 1) * 1000,
    }))
    const lines = reportOf(usage, breakdown, { ...QUIET, agents }, NOW).split('\n')

    expect(lines.filter(line => line.startsWith('• Explore |')).length).toBe(6)
    expect(lines.at(-1)).toBe('y 2 más: 3k tokens')
  })

  test('says so in one line when the engine has no reading yet', () => {
    const text = reportOf({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }, undefined, QUIET, NOW)

    expect(text).toBe('Contexto  sin datos todavía')
  })

  test('writes only lines the transcript knows how to draw', () => {
    const kinds = reportBlocks(reportOf(usage, breakdown, QUIET, NOW)).map(block => block.kind)

    expect(kinds).toEqual(['figure', 'figure', 'figure', 'fact', 'title', 'share', 'share', 'share', 'share', 'title', 'detail', 'title', 'note'])
  })
})
