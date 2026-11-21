import { describe, expect, test } from 'claude-code/testing'

import {
  ID_PRINCIPAL,
  archivarTerminados,
  avatarDe,
  comoArbol,
  contar,
  describirAccion,
  elegirFiltro,
  esHerramientaDePlan,
  filtrar,
  formatearDuracion,
  formatearTokens,
  guardarResumenCorto,
  iniciarAccion,
  iniciarTurno,
  marcarResumenPedido,
  planNuevo,
  registrarSpawn,
  siguienteSinResumen,
  sumarTokens,
  tareaLegible,
  terminarAccion,
  terminarTurno,
  tokensDeUso,
} from '../hooks/modelo'

const spawnIng = { id: 'ing-1', tipo: 'software-engineer', descripcion: 'ING T7: base de datos' }

describe('ciclo de vida de un subagente', () => {
  test('un spawn crea al subagente trabajando, colgado del principal, sin tokens ni plan', async () => {
    const lista = registrarSpawn([], spawnIng, 1000)
    const ing = lista.find(a => a.id === 'ing-1')

    expect(ing?.estado).toBe('trabajando')
    expect(ing?.padreId).toBe(ID_PRINCIPAL)
    expect(ing?.tokens).toBe(0)
    expect(ing?.plan).toEqual([])
    expect(lista.some(a => a.id === ID_PRINCIPAL)).toBe(true)
  })

  test('una acción en curso pasa a recientes al terminar, marcando el fallo', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    lista = iniciarAccion(lista, 'ing-1', { id: 't1', herramienta: 'Bash', texto: 'Compilar', inicio: 10 })
    expect(lista.find(a => a.id === 'ing-1')?.enCurso.length).toBe(1)

    lista = terminarAccion(lista, 'ing-1', 't1', true, 40)
    const ing = lista.find(a => a.id === 'ing-1')
    expect(ing?.enCurso.length).toBe(0)
    expect(ing?.recientes[0]?.fallo).toBe(true)
    expect(ing?.recientes[0]?.fin).toBe(40)
    expect(ing?.totalAcciones).toBe(1)
  })

  test('se guardan las 3 acciones más recientes, la última primero', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    for (let n = 1; n <= 17; n++) {
      lista = iniciarAccion(lista, 'ing-1', { id: `t${n}`, herramienta: 'Read', texto: '', inicio: n })
      lista = terminarAccion(lista, 'ing-1', `t${n}`, false, n)
    }
    const ing = lista.find(a => a.id === 'ing-1')
    expect(ing?.recientes.map(a => a.id)).toEqual(['t17', 't16', 't15'])
    expect(ing?.totalAcciones).toBe(17)
  })

  test('los tokens de cada pedido al modelo se suman al agente que lo hizo', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    lista = sumarTokens(lista, 'ing-1', 1200, 1)
    lista = sumarTokens(lista, 'ing-1', 300, 2)
    lista = sumarTokens(lista, undefined, 50, 3)

    expect(lista.find(a => a.id === 'ing-1')?.tokens).toBe(1500)
    expect(lista.find(a => a.id === ID_PRINCIPAL)?.tokens).toBe(50)
    expect(tokensDeUso({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 })).toBe(334)
  })

  test('el fin de turno decide el estado según el motivo y guarda la respuesta', async () => {
    const base = registrarSpawn([], spawnIng, 0)
    const fin = (motivo: 'answer' | 'aborted' | 'error') =>
      terminarTurno(base, 'ing-1', motivo, '  Listo.\nTodo pasó.  ', 50).find(a => a.id === 'ing-1')

    expect(fin('answer')?.estado).toBe('terminado')
    expect(fin('aborted')?.estado).toBe('detenido')
    expect(fin('error')?.estado).toBe('fallo')
    expect(fin('answer')?.resumen).toBe('Listo.')
    expect(fin('answer')?.respuesta).toBe('Listo.\nTodo pasó.')
  })

  test('el principal queda esperando al usuario y no pide resumen', async () => {
    const lista = terminarTurno(iniciarTurno([], undefined, 0), undefined, 'answer', 'ok', 5)
    const principal = lista.find(a => a.id === ID_PRINCIPAL)
    expect(principal?.estado).toBe('en-espera')
    expect(principal?.resumenPendiente).toBe(false)
  })
})

describe('resumen corto', () => {
  test('al terminar, el subagente queda esperando su resumen, que se pide una sola vez', async () => {
    let lista = terminarTurno(registrarSpawn([], spawnIng, 0), 'ing-1', 'answer', 'Hice muchas cosas', 5)
    expect(siguienteSinResumen(lista)?.id).toBe('ing-1')

    lista = marcarResumenPedido(lista, 'ing-1')
    expect(siguienteSinResumen(lista)).toBe(undefined)
  })

  test('la frase del modelo se guarda limpia: sin comillas, sin punto final, una línea', async () => {
    const lista = guardarResumenCorto(registrarSpawn([], spawnIng, 0), 'ing-1', '"Contó 16 funciones exportadas."\nmás texto')
    expect(lista.find(a => a.id === 'ing-1')?.resumenCorto).toBe('Contó 16 funciones exportadas')
  })
})

describe('plan del agente (su lista de tareas)', () => {
  const todos = [
    { content: 'Leer el modelo', status: 'completed', activeForm: 'Leyendo' },
    { content: 'Delegar el conteo', status: 'in_progress', activeForm: 'Delegando' },
    { content: 'Avisar el resultado', status: 'pending', activeForm: 'Avisando' },
  ]

  test('TodoWrite reemplaza el plan con sus estados', async () => {
    expect(planNuevo([], 'TodoWrite', { todos })).toEqual([
      { texto: 'Leer el modelo', estado: 'hecho' },
      { texto: 'Delegar el conteo', estado: 'en-curso' },
      { texto: 'Avisar el resultado', estado: 'pendiente' },
    ])
  })

  test('el plan de la app avanza como en la app: termina el actual y arranca el siguiente', async () => {
    const plan = planNuevo([], 'mcp__ccd_turn__update_plan', { items: todos.map(({ content, status }) => ({ content, status })) })
    const avanzado = planNuevo(plan, 'mcp__ccd_turn__update_plan', { advance: true })
    expect(avanzado.map(p => p.estado)).toEqual(['hecho', 'hecho', 'en-curso'])
  })

  test('TaskCreate agrega un paso y TaskUpdate lo actualiza por su id', async () => {
    let plan = planNuevo([], 'TaskCreate', { subject: 'Correr los tests', description: '' }, { task: { id: '1', subject: 'x' } })
    plan = planNuevo(plan, 'TaskUpdate', { taskId: '1', status: 'in_progress' })
    expect(plan).toEqual([{ id: '1', texto: 'Correr los tests', estado: 'en-curso' }])
    expect(planNuevo(plan, 'TaskUpdate', { taskId: '1', status: 'deleted' })).toEqual([])
  })

  test('las herramientas de plan no cuentan como acciones', async () => {
    expect(esHerramientaDePlan('TodoWrite')).toBe(true)
    expect(esHerramientaDePlan('mcp__ccd_turn__update_plan')).toBe(true)
    expect(esHerramientaDePlan('Bash')).toBe(false)
  })
})

describe('filtros e historial', () => {
  const armar = () => {
    let lista = registrarSpawn([], spawnIng, 0)
    lista = registrarSpawn(lista, { id: 'test-1', tipo: 'software-tester', descripcion: 'TEST T7' }, 0)
    return terminarTurno(lista, 'ing-1', 'answer', 'ok', 9)
  }

  test('cada filtro muestra lo suyo y cuenta sin el principal', async () => {
    const lista = armar()
    expect(filtrar(lista, 'en-curso').map(a => a.id)).toEqual([ID_PRINCIPAL, 'test-1'])
    expect(filtrar(lista, 'terminados').map(a => a.id)).toEqual(['ing-1'])
    expect(contar(lista)).toEqual({ todos: 2, 'en-curso': 1, terminados: 1, historial: 0 })
  })

  test('limpiar mueve los terminados al historial en vez de borrarlos', async () => {
    const lista = archivarTerminados(armar())
    expect(filtrar(lista, 'todos').map(a => a.id)).toEqual([ID_PRINCIPAL, 'test-1'])
    expect(filtrar(lista, 'historial').map(a => a.id)).toEqual(['ing-1'])
    expect(lista.find(a => a.id === 'ing-1')?.recientes).toEqual([])
  })

  test('tocar el filtro activo vuelve a todos', async () => {
    expect(elegirFiltro('todos', 'terminados')).toBe('terminados')
    expect(elegirFiltro('terminados', 'terminados')).toBe('todos')
  })

})

describe('textos para el panel', () => {
  test('la tarea se muestra sin el código del rol y con mayúscula', async () => {
    expect(tareaLegible('ING T7: preparar la base de datos')).toBe('Preparar la base de datos')
    expect(tareaLegible('ARQ: inicializar el proyecto')).toBe('Inicializar el proyecto')
  })

  test('un comando se cuenta con su descripción, nunca con el comando suelto', async () => {
    expect(describirAccion('Bash', { command: './gradlew build', description: 'compilar el proyecto' })).toBe(
      'Compilar el proyecto',
    )
    expect(describirAccion('Bash', { command: './gradlew test' })).toBe('Correr los tests')
    expect(describirAccion('Bash', { command: 'xyz --raro' })).toBe('Ejecutar un comando')
  })

  test('cada herramienta se cuenta como una tarea corta, al estilo de la app', async () => {
    expect(describirAccion('Read', { file_path: 'C:\\proyecto\\src\\Main.kt' })).toBe('Leer Main.kt')
    expect(describirAccion('Edit', { file_path: '/p/build.gradle' })).toBe('Editar build.gradle')
    expect(describirAccion('Write', { file_path: '/p/README.md' })).toBe('Crear README.md')
    expect(describirAccion('Grep', { pattern: 'TODO' })).toBe('Buscar «TODO»')
    expect(describirAccion('Agent', { description: 'TEST T7: verificar' })).toBe('Delegar: Verificar')
    expect(describirAccion('mcp__srv__crear_evento', {})).toBe('Usar crear_evento')
  })

  test('el árbol pone a cada agente debajo de quien lo creó', async () => {
    let lista = registrarSpawn([], { id: 'arq', tipo: 'software-architect', descripcion: 'ARQ: plan' }, 0)
    lista = registrarSpawn(lista, { ...spawnIng, padreId: 'arq' }, 1)
    expect(comoArbol(lista).map(f => `${f.profundidad}:${f.agente.id}`)).toEqual([`0:${ID_PRINCIPAL}`, '1:arq', '2:ing-1'])
  })

  test('el avatar sale del prefijo de la tarea o del tipo', async () => {
    expect(avatarDe({ id: 'x', tipo: 'general-purpose', descripcion: 'ING T7: algo' }).rol).toBe('ING')
    expect(avatarDe({ id: 'x', tipo: 'otro-tipo', descripcion: '' })).toEqual({ emoji: '🤖', rol: 'otro-tipo' })
  })

  test('las duraciones y los tokens se leen cortos', async () => {
    expect(formatearDuracion(147_000)).toBe('2m 27s')
    expect(formatearTokens(4_800)).toBe('4,8k')
    expect(formatearTokens(48_200)).toBe('48k')
  })
})
