import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement, SessionMessage, SessionUsage } from 'claude-code'

const PLUGIN = 'context-saver'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const
const HOUR = 60 * 60 * 1000
const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'summary', toolUses: [] }]

type World = {
  clock: MockClock
  usage: SessionUsage
  output: string
  isError: boolean
  hasComposer: boolean
  statuses: (string | undefined)[]
  toasts: string[]
  fills: string[]
  compactions: (string | undefined)[]
}

const usageAt = (percent: number | undefined): SessionUsage => ({
  startedAt: 0,
  context: {
    window: 200_000,
    ...(percent === undefined ? {} : { percent, tokens: percent * 2_000 }),
  },
  rateLimits: [],
  cost: { usd: 1.5 },
})

/** Stands for the engine beneath the mod: answers what it asks, records what it shows. */
const worldOf = (on: On, percent: number | undefined): World => {
  const world: World = {
    clock: mock.clock(on),
    usage: usageAt(percent),
    output: 'ok',
    isError: false,
    hasComposer: true,
    statuses: [],
    toasts: [],
    fills: [],
    compactions: [],
  }

  on('session.usage', () => ({ value: world.usage }))
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () =>
    world.isError
      ? { isError: true as const, result: world.output, text: world.output }
      : ({ result: world.output, text: world.output } as never),
  )
  on('prompt.fill', ($, e) => {
    if (world.hasComposer) {
      world.fills.push(e.text)
    }

    return { isFilled: world.hasComposer }
  })
  on('session.compact', ($, e) => {
    world.compactions.push(e.instructions)

    return { messages: SUMMARY }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, null) as RenderElement
  })

  return world
}

const endTurn = ($: Engine) =>
  $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })

const run = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

const read = ($: Engine, file_path: string, limit?: number) =>
  $.tool.call({ tool: 'Read', file_path, ...(limit === undefined ? {} : { limit }) })

test('draws context and cost in the band above the prompt after a turn', async ($, on) => {
  worldOf(on, 42)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^42%$/ }), 'before a turn').toBe(undefined)

    await endTurn($)
    expect((await ui.find({ type: 'Text', text: /^contexto$/ }))?.props).toMatchObject({ color: '#9ca3af' })
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.props).toMatchObject({ bold: true })
    if (surface === 'terminal') {
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.find(one => one.text === '███')?.props, 'used').toMatchObject({ color: '#4ade80' })
      expect(texts.find(one => one.text === '█████')?.props, 'left').toMatchObject({ color: '#4b5563' })
    } else {
      const bar = await ui.find({ type: 'Svg' })
      expect(String(bar?.props.source), 'a rounded bar').toContain('rx="4" fill="#4ade80"')
      expect(bar?.props).toMatchObject({ alt: '42%', width: 120, height: 8 })
    }
    expect(await ui.find({ type: 'Text', text: 'Precio: $1.50' })).toBeDefined()
    expect(await ui.find({ key: 'compact' }), 'no advice at 42%').toBe(undefined)
    await ui.unmount()

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } as never })
  }
})

test('colours the gauges by level', async ($, on) => {
  const world = worldOf(on, 85)
  world.usage = { ...usageAt(85), rateLimits: [{ kind: 'seven_day', percentUsed: 65 }] }

  await endTurn($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const bars = (await ui.findAll({ type: 'Svg' })).map(bar => String(bar.props.source))
  expect(bars.some(source => source.includes('#f87171')), 'a danger bar').toBe(true)
  expect(bars.some(source => source.includes('#fbbf24')), 'a warn bar').toBe(true)
  expect((await ui.find({ type: 'Text', text: /^contexto$/ }))?.props, 'danger colours the label').toMatchObject({
    color: '#f87171',
  })
  expect((await ui.find({ type: 'Text', text: /^85%$/ }))?.props).toMatchObject({ color: '#f87171', bold: true })
  expect((await ui.find({ type: 'Text', text: /^7d$/ }))?.props).toMatchObject({ color: '#9ca3af' })
  expect((await ui.find({ type: 'Text', text: /^65%$/ }))?.props.color).toBe(undefined)
})

test('uses the status line only where the band is not drawn', async ($, on) => {
  const world = worldOf(on, 42)

  await endTurn($)
  expect(world.statuses.at(-1), 'no band yet').toBe('contexto 42% · Precio: $1.50')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await endTurn($)
  expect(world.statuses.at(-1), 'band drawn').toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
})

test('follows the engine during a turn, when a prompt is sent and while idle', async ($, on) => {
  const world = worldOf(on, 20)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shows = async (percent: number) =>
    expect(await ui.find({ type: 'Text', text: new RegExp('^' + percent + '%$') }), percent + '%').toBeDefined()

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  await shows(20)

  world.usage = usageAt(35)
  await run($, 'ls')
  await shows(35)

  world.usage = usageAt(50)
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await shows(50)

  world.usage = usageAt(61)
  await world.clock.advance(60_000)
  await shows(61)
})

const TEN_MINUTES = 10 * 60 * 1000
const NEXT_PROMPT = { text: 'next thing', wait: false, origin: { kind: 'composer' } } as const

/** The buttons the band shows now, by key: the recommended command, then Ignorar. */
const buttonsOf = async (ui: {
  findAll(query: { type: string }): Promise<{ key: string | undefined }[]>
}) => (await ui.findAll({ type: 'Button' })).map(button => button.key)

test('stays quiet under 40%, whatever happened', async ($, on) => {
  const { clock } = worldOf(on, 30)

  await run($, 'git commit -m x')
  await endTurn($)
  await clock.advance(2 * HOUR)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await buttonsOf(ui)).toEqual([])
    await ui.unmount()
  }
})

test('shows the recommended command itself, with Ignorar and no sentence', async ($, on) => {
  worldOf(on, 85)
  await endTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await buttonsOf(ui)).toEqual(['compact', 'ignore'])
    expect((await ui.find({ key: 'compact' }))?.props).toMatchObject({ label: '/compact', variant: 'primary' })
    expect((await ui.find({ key: 'ignore' }))?.props).toMatchObject({ label: 'Ignorar' })
    expect(await ui.find({ type: 'Text', text: 'Recomendado' })).toBe(undefined)
    await ui.unmount()
  }
})

test('recommends /compact at a natural cut from 60%: green tests or a commit, never failed tests', async ($, on) => {
  const world = worldOf(on, 65)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  world.isError = true
  await run($, 'npm test')
  await endTurn($)
  expect(await buttonsOf(ui), 'failed tests').toEqual([])

  world.isError = false
  await run($, 'npm test')
  await endTurn($)
  expect(await buttonsOf(ui), 'green tests').toEqual(['compact', 'ignore'])

  await $.prompt.submit(NEXT_PROMPT)
  expect(await buttonsOf(ui), 'the moment passed').toEqual([])

  await run($, 'git commit -m x')
  await endTurn($)
  expect(await buttonsOf(ui), 'a commit').toEqual(['compact', 'ignore'])
})

test('recommends /clear once the work is committed and the person has stepped away', async ($, on) => {
  const { clock } = worldOf(on, 50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await run($, 'git commit -m x')
  await endTurn($)
  expect(await buttonsOf(ui), 'right after the commit').toEqual([])

  await clock.advance(TEN_MINUTES)
  expect(await buttonsOf(ui), 'after a break').toEqual(['clear', 'ignore'])
  expect((await ui.find({ key: 'clear' }))?.props).toMatchObject({ label: '/clear', variant: 'primary' })
})

test('an edit after the commit is work in progress again: no /clear', async ($, on) => {
  const { clock } = worldOf(on, 50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await run($, 'git commit -m x')
  await $.tool.call({ tool: 'Edit', file_path: 'C:/p/a.ts', old_string: 'a', new_string: 'b' })
  await endTurn($)
  await clock.advance(TEN_MINUTES)

  expect(await buttonsOf(ui)).toEqual([])
})

test('recommends /compact after an hour away with work not committed, from 40%', async ($, on) => {
  const { clock } = worldOf(on, 50)

  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(HOUR - 1)
  expect(await buttonsOf(ui)).toEqual([])

  await clock.advance(1)
  expect(await buttonsOf(ui)).toEqual(['compact', 'ignore'])
})

test('a prompt sent before the pause is over cancels the recommendation', async ($, on) => {
  const { clock } = worldOf(on, 50)

  await run($, 'git commit -m x')
  await endTurn($)
  await $.prompt.submit(NEXT_PROMPT)
  await clock.advance(2 * HOUR)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await buttonsOf(ui)).toEqual([])
})

test('Ignorar hides the recommendation until there is a new reason', async ($, on) => {
  worldOf(on, 65)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await run($, 'npm test')
  await endTurn($)
  await ui.press({ key: 'ignore' })
  expect(await buttonsOf(ui)).toEqual([])

  await run($, 'npm test')
  await endTurn($)
  expect(await buttonsOf(ui)).toEqual(['compact', 'ignore'])
})

test('the button writes its command in the prompt box for the person to send', async ($, on) => {
  const world = worldOf(on, 85)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await endTurn($)
  await ui.press({ key: 'compact' })
  expect(world.fills[0]?.startsWith('/compact Conservá')).toBe(true)

  await run($, 'git commit -m x')
  await endTurn($)
  await world.clock.advance(TEN_MINUTES)
  await ui.press({ key: 'clear' })
  expect(world.fills[1]).toBe('/clear')
  expect(world.compactions).toEqual([])
})

test('when the prompt box refuses, runs nothing and names the command', async ($, on) => {
  const world = worldOf(on, 85)
  world.hasComposer = false
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await endTurn($)
  await ui.press({ key: 'compact' })
  expect(world.toasts.at(-1)).toContain('/compact')
  expect(world.compactions).toEqual([])

  await run($, 'git commit -m x')
  await endTurn($)
  await world.clock.advance(TEN_MINUTES)
  await ui.press({ key: 'clear' })
  expect(world.toasts.at(-1)).toContain('/clear')
})

test('names the tool call that put a large output in the context', async ($, on) => {
  const world = worldOf(on, 20)

  world.output = 'x'.repeat(4_000)
  await read($, 'C:/p/small.ts')
  expect(world.toasts).toEqual([])

  world.output = 'x'.repeat(48_000)
  await read($, 'C:/p/big.ts')
  expect(world.toasts.at(-1)).toMatch(/Read big\.ts.*12\.000 tokens/)
})

test('says when a file was read whole three times, and ignores partial reads', async ($, on) => {
  const world = worldOf(on, 20)

  await read($, 'C:/p/a.ts', 50)
  await read($, 'C:/p/a.ts', 50)
  await read($, 'C:/p/a.ts', 50)
  await read($, 'C:/p/a.ts')
  await read($, 'C:/p/a.ts')
  expect(world.toasts).toEqual([])

  await read($, 'C:/p/a.ts')
  expect(world.toasts.at(-1)).toMatch(/a\.ts.*3 veces/)
})

test('announces a rate-limit window near its cap once', async ($, on) => {
  const world = worldOf(on, 20)
  world.usage = {
    ...usageAt(20),
    rateLimits: [{ kind: 'five_hour', percentUsed: 82.5 }],
  }

  await endTurn($)
  await endTurn($)

  expect(world.toasts).toEqual(['Límite de uso 5h al 83%.'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^83%$/ }))?.props).toMatchObject({ color: '#f87171' })
})

test('/uso reports the context and what the session spent', async ($, on) => {
  const world = worldOf(on, 42)

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  world.output = 'x'.repeat(48_000)
  await read($, 'C:/p/big.ts')
  const ran = await $.command.run({
    command: 'uso',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(ran.text).toContain('42% · 84k de 200k tokens')
  expect(ran.text).toContain('Salidas grandes: Read big.ts ~12k')
})

test('starts over after a compaction and after /clear', async ($, on) => {
  const world = worldOf(on, 85)

  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'compact' })).toBeDefined()

  world.usage = usageAt(undefined)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await ui.find({ key: 'compact' })).toBe(undefined)

  world.usage = usageAt(85)
  await endTurn($)
  expect(await ui.find({ key: 'compact' })).toBeDefined()

  await $.session.end({
    reason: 'clear',
    sessionId: 's1',
    resume: { sessionId: 's1' } as never,
  })
  expect(await ui.find({ key: 'compact' })).toBe(undefined)

  const footer = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await footer.find({ type: 'Text', text: /^85%$/ })).toBe(undefined)
})
