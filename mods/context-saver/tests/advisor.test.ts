import { describe, expect, test } from 'claude-code/testing'

import {
  adviceFor,
  afterFill,
  barCellsFor,
  cutOf,
  estimateTokens,
  figuresOf,
  filledCells,
  reportOf,
  resetIn,
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
      context: { label: 'ctx', percent: 42, level: 'ok' },
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

describe('reportOf', () => {
  test('groups MCP tools by connector and lists what the session spent', () => {
    const text = reportOf(
      {
        startedAt: 0,
        context: { window: 200_000, tokens: 84_000, percent: 42 },
        cost: { usd: 2 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 57, resetsAt: '2026-10-11T16:13:00Z' },
          { kind: 'seven_day', percentUsed: 80.4 },
        ],
      },
      {
        categories: [
          { name: 'Messages', tokens: 50_000, color: 'text', isDeferred: false, kind: 'used' },
          { name: 'MCP tools', tokens: 9_000, color: 'text', isDeferred: false, kind: 'used' },
          { name: 'Free space', tokens: 116_000, color: 'text', isDeferred: false, kind: 'free' },
        ],
        mcpTools: [
          { name: 'mcp__figma__a', serverName: 'figma', tokens: 5_000, isLoaded: true },
          { name: 'mcp__figma__b', serverName: 'figma', tokens: 3_000, isLoaded: true },
          { name: 'mcp__gmail__a', serverName: 'gmail', tokens: 1_000, isLoaded: true },
          { name: 'mcp__drive__a', serverName: 'drive', tokens: 700, isLoaded: false },
        ],
        memoryFiles: [{ path: 'C:/u/.claude/CLAUDE.md', type: 'User', tokens: 1_200 }],
        skills: { totalSkills: 60, includedSkills: 55, tokens: 4_000, skillFrontmatter: [] },
      },
      {
        bigOutputs: [{ tool: 'Read', target: 'big.ts', tokens: 12_000 }],
        fullReads: { 'C:/p/a.ts': 3, 'C:/p/b.ts': 1 },
      },
      NOW,
    )

    expect(text).toContain('84.000 de 200.000 tokens (42%)')
    expect(text).toContain('5h: 57% (se reinicia en 2 h 13 min)')
    expect(text).toContain('7d: 80,4%')
    expect(text).toContain('Messages: 50.000')
    expect(text).not.toContain('Free space')
    expect(text).toContain('figma: 8.000 (2 herramientas)')
    expect(text).toContain('1 conector con esquemas diferidos')
    expect(text).toContain('Skills: 55 listadas, 4.000')
    expect(text).toContain('CLAUDE.md (User): 1.200')
    expect(text).toContain('Read big.ts: ~12.000')
    expect(text).toContain('a.ts ×3')
    expect(text).not.toContain('b.ts')
  })

  test('says so when the engine gave no breakdown', () => {
    const text = reportOf(
      { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
      undefined,
      { bigOutputs: [], fullReads: {} },
      NOW,
    )

    expect(text).toContain('sin datos')
  })
})
