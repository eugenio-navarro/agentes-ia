import { describe, expect, test } from 'claude-code/testing'

import {
  adviceFor,
  afterFill,
  barCellsFor,
  barSvg,
  cutOf,
  estimateTokens,
  figuresOf,
  filledCells,
  messageOf,
  offersClear,
  reportOf,
  resetIn,
  shortCount,
  statusTextOf,
} from '../hooks/advisor'
import type { Signals } from '../types'

const signals = (over: Partial<Signals>): Signals => ({
  percent: null,
  cut: null,
  isIdle: false,
  hidden: null,
  ...over,
})

describe('adviceFor', () => {
  test('stays quiet before the first response and under 40%', () => {
    expect(adviceFor(signals({ cut: 'commit' }))).toBe(null)
    expect(adviceFor(signals({ percent: 39, cut: 'commit', isIdle: true }))).toBe(null)
  })

  test('offers both ways out after a commit from 40%', () => {
    expect(adviceFor(signals({ percent: 40, cut: 'commit' }))).toBe('commit')
  })

  test('suggests compacting on green tests only from 60%', () => {
    expect(adviceFor(signals({ percent: 59, cut: 'tests' }))).toBe(null)
    expect(adviceFor(signals({ percent: 60, cut: 'tests' }))).toBe('tests')
  })

  test('says nothing between 40% and 80% without a natural cut', () => {
    expect(adviceFor(signals({ percent: 79 }))).toBe(null)
  })

  test('insists from 80% whatever else is true', () => {
    expect(adviceFor(signals({ percent: 80 }))).toBe('urgent')
    expect(adviceFor(signals({ percent: 95, cut: 'commit', isIdle: true }))).toBe('urgent')
  })

  test('warns after a long pause from 40%, ahead of a cut', () => {
    expect(adviceFor(signals({ percent: 45, isIdle: true, cut: 'commit' }))).toBe('idle')
  })

  test('keeps a hidden advice hidden until a more pressing one comes', () => {
    expect(adviceFor(signals({ percent: 50, cut: 'commit', hidden: 'commit' }))).toBe(null)
    expect(adviceFor(signals({ percent: 85, cut: 'commit', hidden: 'commit' }))).toBe('urgent')
  })
})

describe('the recommendation', () => {
  const KINDS = ['urgent', 'idle', 'commit', 'tests'] as const

  test('always names the command it recommends, first', () => {
    for (const kind of KINDS) {
      expect(messageOf(kind, 70), kind).toMatch(/^Recomendado: \/compact\. /)
    }
  })

  test('offers /clear only where a change of subject is plausible, and says so', () => {
    expect(KINDS.filter(offersClear)).toEqual(['idle', 'commit'])

    for (const kind of KINDS) {
      expect(messageOf(kind, 70).includes('/clear'), kind).toBe(offersClear(kind))
    }
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

    expect(text).toBe('ctx 42% · 5h 57% · $1.23')
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
  const QUIET = { bigOutputs: [], fullReads: {} }

  test('opens with one bar per figure: context, each usage window, then the cost', () => {
    const lines = reportOf(usage, breakdown, QUIET, NOW).split('\n')

    expect(lines.slice(0, 4)).toEqual([
      'Contexto  ██████████░░░░░░░░░░  48% · 476k de 1M tokens',
      '5 horas   ██████████████████░░  90% · se reinicia en 1 h 11 min',
      '7 días    █████████████████░░░  85%',
      'Costo de la sesión: $16.45',
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
