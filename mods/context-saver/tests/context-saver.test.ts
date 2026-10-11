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
    expect((await ui.find({ type: 'Text', text: /^ctx$/ }))?.props).toMatchObject({ color: '#9ca3af' })
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.props).toMatchObject({ bold: true })
    expect((await ui.find({ type: 'Text', text: /^━{3}$/ }))?.props, 'used').toMatchObject({ color: '#4ade80' })
    expect((await ui.find({ type: 'Text', text: /^━{5}$/ }))?.props, 'left').toMatchObject({ color: '#4b5563' })
    expect(await ui.find({ type: 'Text', text: '$1.50' })).toBeDefined()
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
  const colours = (await ui.findAll({ type: 'Text', text: /^━+$/ })).map(bar => bar.props.color)
  expect(colours).toEqual(expect.arrayContaining(['#f87171', '#fbbf24']))
  expect((await ui.find({ type: 'Text', text: /^ctx$/ }))?.props, 'danger colours the label').toMatchObject({
    color: '#f87171',
  })
  expect((await ui.find({ type: 'Text', text: /^85%$/ }))?.props).toMatchObject({ color: '#f87171', bold: true })
  expect((await ui.find({ type: 'Text', text: /^7d$/ }))?.props).toMatchObject({ color: '#9ca3af' })
  expect((await ui.find({ type: 'Text', text: /^65%$/ }))?.props.color).toBe(undefined)
})

test('uses the status line only where the band is not drawn', async ($, on) => {
  const world = worldOf(on, 42)

  await endTurn($)
  expect(world.statuses.at(-1), 'no band yet').toBe('ctx 42% · $1.50')

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

test('stays quiet under 40% even after a commit', async ($, on) => {
  worldOf(on, 30)

  await run($, 'git commit -m x')
  await endTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
    await ui.unmount()
  }
})

test('offers /compact and /clear after a commit from 40%', async ($, on) => {
  worldOf(on, 50)

  await run($, 'git commit -m x')
  await endTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Commit hecho.*50%/ })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect(await ui.find({ key: 'clear' })).toBeDefined()
    expect(await ui.find({ key: 'hide' })).toBeDefined()
    await ui.unmount()
  }
})

test('suggests compacting on green tests from 60%, not on failed ones', async ($, on) => {
  const world = worldOf(on, 65)

  world.isError = true
  await run($, 'npm test')
  await endTurn($)
  const failed = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await failed.find({ key: 'compact' })).toBe(undefined)
  await failed.unmount()

  world.isError = false
  await run($, 'npm test')
  await endTurn($)
  const green = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await green.find({ type: 'Text', text: /Tests en verde.*65%/ })).toBeDefined()
  await green.unmount()
})

test('insists from 80% with no natural cut', async ($, on) => {
  worldOf(on, 85)

  await endTurn($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Recomendado: \/compact\. .*85%.*compactar ahora/})).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  expect(await ui.find({ key: 'clear' }), 'a clear case offers no /clear').toBe(undefined)
  expect(await ui.find({ key: 'hide' })).toBeDefined()
})

test('hides the advice when asked, and the next prompt drops a cut', async ($, on) => {
  worldOf(on, 50)

  await run($, 'git commit -m x')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'compact' })).toBe(undefined)

  await run($, 'git commit -m y')
  await endTurn($)
  expect(await ui.find({ key: 'compact' })).toBeDefined()

  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: 'compact' })).toBe(undefined)
})

test('writes the command in the prompt box for the person to send', async ($, on) => {
  const world = worldOf(on, 50)

  await run($, 'git commit -m x')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'clear' })

  expect(world.fills[0]).toMatch(/^\/compact Conservá/)
  expect(world.fills[1]).toBe('/clear')
  expect(world.compactions).toEqual([])
})

test('when the prompt box refuses, runs nothing and names the command', async ($, on) => {
  const world = worldOf(on, 50)
  world.hasComposer = false

  await run($, 'git commit -m x')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'clear' })
  expect(world.toasts.at(-1)).toContain('/clear')

  await ui.press({ key: 'compact' })
  expect(world.toasts.at(-1)).toContain('/compact')
  expect(world.compactions).toEqual([])
  expect(await ui.find({ key: 'compact' })).toBeDefined()
})

test('warns after a long pause from 40%', async ($, on) => {
  const { clock } = worldOf(on, 50)

  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(HOUR - 1)
  expect(await ui.find({ key: 'compact' })).toBe(undefined)

  await clock.advance(1)
  expect(await ui.find({ type: 'Text', text: /Pausa larga.*50%/ })).toBeDefined()
})

test('a prompt sent before the pause is over cancels the warning', async ($, on) => {
  const { clock } = worldOf(on, 50)

  await endTurn($)
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await clock.advance(2 * HOUR)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'compact' })).toBe(undefined)
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

test('/ahorro reports the context and what the session spent', async ($, on) => {
  const world = worldOf(on, 42)

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  world.output = 'x'.repeat(48_000)
  await read($, 'C:/p/big.ts')
  const ran = await $.command.run({
    command: 'ahorro',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(ran.text).toContain('84.000 de 200.000 tokens (42%)')
  expect(ran.text).toContain('Read big.ts: ~12.000')
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
