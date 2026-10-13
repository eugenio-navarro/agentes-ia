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
  refusesCommands: boolean
  statuses: (string | undefined)[]
  toasts: string[]
  commands: string[]
  agents: { id: string; type: string; description: string }[]
  compactions: (string | undefined)[]
  topicAnswer: string | null
  asked: string[]
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
    refusesCommands: false,
    statuses: [],
    toasts: [],
    commands: [],
    agents: [],
    compactions: [],
    topicAnswer: 'MISMO',
    asked: [],
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
  on('agent.list', () => ({ value: world.agents.map(one => ({ ...one, status: 'running' })) as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () =>
    world.isError
      ? { isError: true as const, result: world.output, text: world.output }
      : ({ result: world.output, text: world.output } as never),
  )
  on('command.run', ($, e) => {
    if (world.refusesCommands) {
      throw new Error('not now')
    }

    world.commands.push(`/${e.command} ${e.args}`.trim())

    return { text: '' }
  })
  on('model.complete', ($, e) => {
    world.asked.push(e.prompt)
    const usage = { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const reply =
      world.topicAnswer === null
        ? { isAnswered: false, reason: 'empty-reply', usage }
        : { isAnswered: true, text: world.topicAnswer, usage }

    return { value: reply as never }
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
    expect((await ui.find({ type: 'Text', text: /^Contexto$/ }))?.props).toMatchObject({ color: '#9ca3af' })
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.props).toMatchObject({ bold: true })
    if (surface === 'terminal') {
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.find(one => one.text === '███████')?.props, 'used').toMatchObject({ color: '#4ade80' })
      expect(texts.find(one => one.text === '█████████')?.props, 'left').toMatchObject({ color: '#4b5563' })
    } else {
      const bar = await ui.find({ type: 'Svg' })
      expect(String(bar?.props.source), 'a rounded bar').toContain('rx="4" fill="#4ade80"')
      expect(bar?.props).toMatchObject({ alt: '42%', width: 128, height: 8 })
    }
    const shown = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    expect(shown, 'the price with its label, in one piece').toContain('Precio: $1.50')
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
  expect((await ui.find({ type: 'Text', text: /^Contexto$/ }))?.props, 'danger colours the label').toMatchObject({
    color: '#f87171',
  })
  expect((await ui.find({ type: 'Text', text: /^85%$/ }))?.props).toMatchObject({ color: '#f87171', bold: true })
  expect((await ui.find({ type: 'Text', text: /^7d$/ }))?.props).toMatchObject({ color: '#9ca3af' })
  expect((await ui.find({ type: 'Text', text: /^65%$/ }))?.props.color).toBe(undefined)
})

test('uses the status line only where the band is not drawn', async ($, on) => {
  const world = worldOf(on, 42)

  await endTurn($)
  expect(world.statuses.at(-1), 'no band yet').toBe('Contexto 42% · Precio: $1.50')

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

test('sizes the bars to the room the row leaves, with the same gaps with or without the buttons', async ($, on) => {
  const world = worldOf(on, 42)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 }, surface: 'desktop' })
  const row = async () => (await ui.findAll({ type: 'Box' }))[0]?.props
  const barWidth = async () => (await ui.find({ type: 'Svg' }))?.props.width

  await endTurn($)
  expect(await buttonsOf(ui), 'no buttons').toEqual([])
  expect(await barWidth(), 'the bar takes the room').toBe(128)
  expect(await row()).toMatchObject({ columnGap: 2 })
  expect((await row())?.justifyContent, 'centred, nothing pushed apart').toBe('center')

  world.usage = usageAt(85)
  await endTurn($)
  expect(await buttonsOf(ui), 'with buttons').toEqual(['compact', 'ignore'])
  expect(await barWidth(), 'the bar leaves the buttons their room').toBe(56)
  expect(await row()).toMatchObject({ columnGap: 2 })
  expect((await row())?.justifyContent).toBe('center')
})

test('centres the row in the band in every case: either surface, with or without buttons, price or windows', async ($, on) => {
  const world = worldOf(on, 42)
  const noPrice: SessionUsage = { startedAt: 0, context: usageAt(42).context, rateLimits: [] }
  const windows: SessionUsage = {
    ...usageAt(42),
    rateLimits: [
      { kind: 'five_hour', percentUsed: 0 },
      { kind: 'seven_day', percentUsed: 65 },
    ],
  }
  // Windows last: once seen, the mod keeps showing them.
  const cases: [string, SessionUsage, string[], string][] = [
    ['context and price', usageAt(42), [], 'Precio: $1.50'],
    ['with the buttons', usageAt(85), ['compact', 'ignore'], 'Precio: $1.50'],
    ['no price', noPrice, [], '42%'],
    ['a window at 0%', windows, [], '0%'],
  ]

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    for (const [name, usage, buttons, shown] of cases) {
      world.usage = usage
      await endTurn($)

      expect((await ui.findAll({ type: 'Box' }))[0]?.props, `${surface}: ${name}`).toMatchObject({
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        columnGap: 2,
        flexWrap: 'wrap',
      })
      expect(await buttonsOf(ui), `${surface}: ${name}`).toEqual(buttons)
      expect((await ui.findAll({ type: 'Text' })).map(one => one.text), `${surface}: ${name}`).toContain(shown)
    }

    await ui.unmount()
  }
})

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
    const shortcuts = (await ui.findAll({ type: 'Button' })).map(button => button.props.hotkey)
    expect(shortcuts, 'no shortcut numbers beside the buttons').toEqual([undefined, undefined])
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

test('the button runs its command itself, as if the person had typed it', async ($, on) => {
  const world = worldOf(on, 85)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await endTurn($)
  await ui.press({ key: 'compact' })
  expect(world.commands[0]?.startsWith('/compact Conservá')).toBe(true)

  await run($, 'git commit -m x')
  await endTurn($)
  await world.clock.advance(TEN_MINUTES)
  await ui.press({ key: 'clear' })
  expect(world.commands[1]).toBe('/clear')
  expect(world.toasts, 'nothing to explain').toEqual([])
})

test('when the engine will not run the command, says so and names it', async ($, on) => {
  const world = worldOf(on, 85)
  world.refusesCommands = true
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await endTurn($)
  await ui.press({ key: 'compact' })
  expect(world.toasts.at(-1)).toContain('/compact')

  await run($, 'git commit -m x')
  await endTurn($)
  await world.clock.advance(TEN_MINUTES)
  await ui.press({ key: 'clear' })
  expect(world.toasts.at(-1)).toContain('/clear')
  expect(world.commands).toEqual([])
})

const FIRST_PROMPT = 'arreglá el cálculo de impuestos en la factura por favor'
const OTHER_PROMPT = 'ahora quiero armar el script de despliegue del servidor de producción'

const send = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('asks the small model about a change of subject only when it can matter', async ($, on) => {
  const world = worldOf(on, 30)

  await send($, FIRST_PROMPT)
  await send($, OTHER_PROMPT)
  expect(world.asked, 'under 40% nothing is worth clearing').toEqual([])

  world.usage = usageAt(50)
  await send($, 'dale')
  await send($, '/uso ahora mismo por favor y gracias')
  expect(world.asked, 'short replies and commands cost nothing').toEqual([])

  await send($, OTHER_PROMPT)
  expect(world.asked).toHaveLength(1)
  expect(world.asked[0]).toContain(FIRST_PROMPT)
  expect(world.asked[0]).toContain('Mensaje nuevo:\n' + OTHER_PROMPT)
})

test('after a change of subject, recommends a /compact that keeps only the new one', async ($, on) => {
  const world = worldOf(on, 50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await send($, FIRST_PROMPT)
  await send($, 'y agregá también un test para el redondeo de centavos')
  await endTurn($)
  expect(await buttonsOf(ui), 'the same subject').toEqual([])

  world.topicAnswer = 'NUEVO'
  await send($, OTHER_PROMPT)
  await endTurn($)
  expect(await buttonsOf(ui)).toEqual(['compact', 'ignore'])

  await ui.press({ key: 'compact' })
  expect(world.commands.at(-1)?.startsWith('/compact Cambio de tema')).toBe(true)
  expect(world.commands.at(-1)).toContain(OTHER_PROMPT)
})

test('Ignorar on a change of subject drops it, and later prompts are compared with the new subject', async ($, on) => {
  const world = worldOf(on, 50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await send($, FIRST_PROMPT)
  world.topicAnswer = 'NUEVO'
  await send($, OTHER_PROMPT)
  await endTurn($)
  await ui.press({ key: 'ignore' })

  world.topicAnswer = 'MISMO'
  await send($, 'dale')
  await endTurn($)
  expect(await buttonsOf(ui), 'ignored').toEqual([])

  await send($, 'y que el despliegue corra las migraciones antes de levantar')
  expect(world.asked.at(-1)).toContain(OTHER_PROMPT)
  expect(world.asked.at(-1)).not.toContain(FIRST_PROMPT)
})

test('an unclear or failed answer from the model recommends nothing', async ($, on) => {
  const world = worldOf(on, 50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await send($, FIRST_PROMPT)
  for (const answer of ['no estoy seguro', null]) {
    world.topicAnswer = answer
    await send($, OTHER_PROMPT)
    await endTurn($)
    expect(await buttonsOf(ui), String(answer)).toEqual([])
  }
})

test('/uso says what the detection itself spent', async ($, on) => {
  worldOf(on, 50)

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  await send($, FIRST_PROMPT)
  await send($, OTHER_PROMPT)
  const ran = await $.command.run({
    command: 'uso',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(ran.text).toContain('Detección de cambio de tema: 1 consulta del mod a Haiku · 302 tokens')
})

test('/uso lists each agent with what it processed, and keeps the list after a compaction', async ($, on) => {
  const world = worldOf(on, 50)
  world.agents = [
    { id: 'a1', type: 'software-engineer', description: 'ING: implementar login' },
    { id: 'a2', type: 'Explore', description: 'buscar usos' },
  ]
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 3000,
    cache_creation_input_tokens: 800,
    model: 'claude-haiku-5-5',
  }
  const agentTurn = (agentId: string, spent?: typeof usage) =>
    $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      turnId: 't2',
      reason: 'answer',
      agentId,
      ...(spent === undefined ? {} : { usage: spent }),
    })
  const report = async () =>
    (
      await $.command.run({
        command: 'uso',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 80 },
      })
    ).text

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  await endTurn($)
  expect(await report(), 'the main loop is no agent').toContain('Agentes\nNo se usaron agentes en esta sesión.')

  await agentTurn('a1', usage)
  await agentTurn('a1', usage)
  await agentTurn('a2')
  // The engine drops an agent from its list once it ends: what was noted stays.
  world.agents = []
  const listed =
    'Agentes\n• software-engineer | ING: implementar login | 10k tokens\n• Explore | buscar usos | 0 tokens'
  expect(await report()).toContain(listed)

  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await endTurn($)
  expect(await report(), 'the session spent it, not the conversation').toContain(listed)
})

test("draws the /uso report in the transcript with the band's bars, a title per part and one row per figure", async ($, on) => {
  worldOf(on, 20)
  // As the engine hands it over: the plugin's name before what the command answered.
  const text = [
    'context-saver: Contexto  ██████████░░░░░░░░░░  48% · 476k de 1M tokens',
    '7 días    █████████████████░░░  85%',
    'Precio de la sesión: $16.45',
    '',
    'Qué ocupa el contexto',
    '• Conversación: 400k (85%)',
    '',
    'Detalle del gasto',
    '• Conectores más pesados: browser 11k',
    '',
    'Agentes',
    '• Explore | buscar usos | 80k tokens',
  ].join('\n')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'CommandOutput',
      props: { command: 'uso', args: '', text, isErrored: false },
    })
    const bold = (await ui.findAll({ type: 'Text' })).filter(one => one.props.bold === true).map(one => one.text)
    expect(bold).toEqual(
      expect.arrayContaining(['Uso', 'Qué ocupa el contexto', 'Detalle del gasto', 'Agentes', '48%', '85%', '$16.45', '80k tokens']),
    )

    const texts = await ui.findAll({ type: 'Text' })
    const labelOf = (text: string) => texts.find(one => one.text === text)?.props
    expect(labelOf('Conectores más pesados'), 'a detail reads as the rows above it').toMatchObject(
      labelOf('Conversación') ?? {},
    )
    expect(labelOf('Conectores más pesados')).toMatchObject({ color: '#9ca3af' })
    expect(texts.map(one => one.text)).toContain('browser 11k')
    expect(labelOf('Explore'), 'an agent reads as the rows above it').toMatchObject({ color: '#9ca3af' })
    expect(texts.map(one => one.text)).toContain('buscar usos')
    expect(texts.map(one => one.text), 'the first label, without the name').toContain('Contexto')
    expect(texts.some(one => String(one.text).includes('context-saver'))).toBe(false)

    const bars = (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source))
    expect(bars.length, 'vector bars only where the surface draws them').toBe(surface === 'terminal' ? 0 : 3)

    if (surface !== 'terminal') {
      expect(bars[0], 'context at 48%').toContain('#4ade80')
      expect(bars[1], 'a window at 85%').toContain('#f87171')
    }

    await ui.unmount()
  }
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

test('keeps a usage window on screen at 0% after the engine stops reporting it', async ($, on) => {
  const world = worldOf(on, 20)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(one => one.text)

  world.usage = {
    ...usageAt(20),
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(2 * 60_000).toISOString() }],
  }
  await endTurn($)
  expect(await texts()).toEqual(expect.arrayContaining(['5h', '42%']))

  world.usage = usageAt(20)
  await world.clock.advance(3 * 60_000)
  await endTurn($)
  expect(await texts(), 'still there, reset to zero').toEqual(expect.arrayContaining(['5h', '0%']))
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
