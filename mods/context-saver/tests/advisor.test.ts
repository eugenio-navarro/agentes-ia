import { describe, expect, test } from 'claude-code/testing'

import {
  adviceFor,
  afterFill,
  barCellsFor,
  barSvg,
  commandFor,
  cutOf,
  estimateTokens,
  figuresOf,
  filledCells,
  isWorthAsking,
  ledgerFrom,
  reportOf,
  resetIn,
  shortCount,
  signalsFrom,
  statusTextOf,
  topicAnswer,
  topicInstructions,
  topicQuestion,
} from '../hooks/advisor'
import type { Signals } from '../types'

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

    expect(ledger).toEqual({ bigOutputs: [big], fullReads: {}, prompts: [], classifier: { asked: 0, tokens: 0 } })
    expect(reportOf({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }, undefined, ledger, 0)).toContain('Salidas grandes')
  })

  test('starts from the defaults when nothing is stored', () => {
    expect(signalsFrom(undefined)).toEqual({ percent: null, cut: null, pause: 'none', hidden: null, topic: null })
    expect(ledgerFrom(null).classifier).toEqual({ asked: 0, tokens: 0 })
  })
})

describe('afterFill', () => {
  test('compacts by itself only where the engine says no prompt box exists', () => {
    expect(afterFill({ isFilled: true })).toBe('written')
    expect(afterFill({ isFilled: false, refusal: 'no_composer' })).toBe('no-box')
    expect(afterFill({ isFilled: false, refusal: 'dialog' })).toBe('refused')
    expect(afterFill({ isFilled: false })).toBe('refused')
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

describe('barCellsFor', () => {
  test('gives longer bars to a wider band', () => {
    expect([40, 70, 99, 100, 160].map(barCellsFor)).toEqual([5, 8, 8, 14, 14])
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
  const QUIET = { bigOutputs: [], fullReads: {}, prompts: [], classifier: { asked: 0, tokens: 0 } }

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
    expect(quiet).toContain('Conectores más pesados: browser 11k · gmail 1k')
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
    expect(busy).toContain('Salidas grandes: Read big.ts ~12k')
    expect(busy).toContain('Releídos enteros: a.ts ×3')
    expect(busy).not.toContain('b.ts')
  })

  test('says so in one line when the engine has no reading yet', () => {
    const text = reportOf({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }, undefined, QUIET, NOW)

    expect(text).toBe('Contexto  sin datos todavía')
  })
})
