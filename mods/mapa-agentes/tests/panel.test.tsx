import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANEL = {
  plugin: 'mapa-agentes',
  component: 'Pane',
  requestId: 'mapa-agentes',
  props: {
    title: 'Mapa de agentes',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SPAWN_ING = {
  tool_use_id: 'toolu_agent',
  prompt: 'Prepará la base de datos',
  description: 'ING T7: preparar la base de datos',
  subagentType: 'software-engineer',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'opus',
  background: true,
  fork: false,
} as const

const FIN_ING = (answer: string) =>
  ({ answer, durationMs: 5, isAborted: false, turnId: 't', agentId: 'ing-1', reason: 'answer' }) as const

/** Los hooks de acá representan al motor, debajo del mod. */
function motor(on: On) {
  const reloj = mock.clock(on)
  on('command.register', () => ({ value: { command: 'agentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ing-1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  return reloj
}

test('la tarjeta muestra avatar, tarea legible, estado y pasos como tareas cortas', async ($, on) => {
  const reloj = motor(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(SPAWN_ING)
  await $.tool.call({ tool: 'Bash', command: './gradlew clean build', description: 'Compilar el proyecto' })
  await reloj.advance(3000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANEL, surface })
    expect((await ui.find({ type: 'Text', text: /^ING$/ }))?.text).toBe('ING')
    expect((await ui.find({ type: 'Text', text: /base de datos/ }))?.text).toBe('Preparar la base de datos')
    expect((await ui.find({ type: 'Text', text: /Trabajando/ }))?.text).toBe('◌ Trabajando')
    expect((await ui.find({ type: 'Text', text: /0 acciones/ }))?.text).toBe('⏱ 3s · 0 acciones · 0 tokens')
    expect((await ui.find({ type: 'Text', text: /Compilar el proyecto/ }))?.text).toBe('Compilar el proyecto')
    expect(await ui.find({ type: 'Text', text: /gradlew/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /En vivo/ }))?.text).toBe('● En vivo')
    await ui.unmount()
  }
})

test('si el agente escribe su lista de tareas, la tarjeta muestra esos pasos', async ($, on) => {
  motor(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Leer el modelo', status: 'completed', activeForm: 'Leyendo' },
      { content: 'Contar funciones', status: 'in_progress', activeForm: 'Contando' },
    ],
  })

  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Leer el modelo/ }))?.text).toBe('Leer el modelo')
  expect((await ui.find({ type: 'Text', text: /Contar funciones/ }))?.text).toBe('Contar funciones')
  // Llevar la lista no es una acción de trabajo.
  expect((await ui.find({ type: 'Text', text: /acciones/ }))?.text).toContain('0 acciones')
  await ui.unmount()
})

test('al terminar, la tarjeta muestra "Resumen:" con la frase corta del modelo', async ($, on) => {
  const reloj = motor(on)
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Preparó la base de datos',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(SPAWN_ING)
  await $.turn.complete(FIN_ING('Listo, creé las tablas y las migraciones.'))
  await reloj.advance(2000)

  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Resumen:$/ }))?.text).toBe('Resumen:')
  expect((await ui.find({ type: 'Text', text: /^Preparó/ }))?.text).toBe('Preparó la base de datos')
  // La respuesta completa no se muestra: solo el resumen.
  expect(await ui.find({ type: 'Text', text: /creé las tablas/ })).toBe(undefined)
  await ui.unmount()
})

test('los filtros muestran solo lo suyo y limpiar guarda en el historial', async ($, on) => {
  motor(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(SPAWN_ING)
  await $.turn.complete(FIN_ING('ok'))

  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  await ui.press({ key: 'filtro-en-curso' })
  expect(await ui.find({ type: 'Text', text: /^ING$/ })).toBe(undefined)

  await ui.press({ key: 'filtro-en-curso' })
  expect((await ui.find({ type: 'Text', text: /^ING$/ }))?.text).toBe('ING')

  await ui.press({ key: 'limpiar' })
  expect(await ui.find({ type: 'Text', text: /^ING$/ })).toBe(undefined)

  await ui.press({ key: 'filtro-historial' })
  expect((await ui.find({ type: 'Text', text: /^ING$/ }))?.text).toBe('ING')
  await ui.unmount()
})

test('cada tarjeta muestra solo las 3 acciones más recientes', async ($, on) => {
  motor(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const archivo of ['a.kt', 'b.kt', 'c.kt', 'd.kt', 'e.kt']) {
    await $.tool.call({ tool: 'Read', file_path: `/p/${archivo}` })
  }

  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Leer b\.kt/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /Leer c\.kt/ }))?.text).toBe('Leer c.kt')
  expect((await ui.find({ type: 'Text', text: /Leer e\.kt/ }))?.text).toBe('Leer e.kt')
  expect(await ui.find({ type: 'Button', text: /Detalles/ })).toBe(undefined)
  await ui.unmount()
})

test('sin actividad, el panel lo dice', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Sin agentes/ }))?.text).toBe('Sin agentes todavía')
  await ui.unmount()
})

test('lo guardado por una versión vieja del mod se descarta sin romper el panel', async ($, on) => {
  mock.clock(on)
  on('state.get', () => ({ value: { value: [{ nombre: 'viejo' }], version: 1 } }))
  const ui = await $.ui.mount({ ...PANEL, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Sin agentes/ }))?.text).toBe('Sin agentes todavía')
  await ui.unmount()
})

test('en un panel angosto, la tarjeta pasa a una sola columna y los filtros se acortan', async ($, on) => {
  motor(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(SPAWN_ING)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANEL, surface, props: { ...PANEL.props, bodyColumns: 30 } })
    // Sin caja de avatar: el emoji va junto al rol, y el estado en su propia línea.
    expect((await ui.find({ type: 'Text', text: /^🔨 ING$/u }))?.text).toBe('🔨 ING')
    expect((await ui.find({ type: 'Text', text: /Trabajando/ }))?.text).toBe('◌ Trabajando')
    expect((await ui.find({ type: 'Button', text: /^👥/u }))?.text).toBe('👥 1')
    expect((await ui.find({ type: 'Text', text: /tok$/ }))?.text).toBe('⏱ 0s · 0 tok')
    await ui.unmount()
  }
})
