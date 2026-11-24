import { describe, expect, test } from 'claude-code/testing'

import {
  ID_PRINCIPAL,
  anotarNarracion,
  detalleDeAccion,
  guardarNombreTramo,
  marcarTramoPedido,
  pedidoDeNombreTramo,
  siguienteTramoSinNombre,
  ESPERA_ARCHIVO_MS,
  archivarViejos,
  hayParaArchivar,
  nombrarPrincipal,
  rolDe,
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

  test('una acción termina marcando el fallo en su tramo', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    lista = iniciarAccion(lista, 'ing-1', { id: 't1', herramienta: 'Bash', texto: 'Compilar', inicio: 10 })
    expect(lista.find(a => a.id === 'ing-1')?.enCurso.length).toBe(1)

    lista = terminarAccion(lista, 'ing-1', 't1', true, 40)
    const ing = lista.find(a => a.id === 'ing-1')
    expect(ing?.enCurso.length).toBe(0)
    expect(ing?.tramos[0]?.fallo).toBe(true)
    expect(ing?.tramos[0]?.fin).toBe(40)
    expect(ing?.totalAcciones).toBe(1)
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

describe('tramos (pasos nombrados por lo que logran)', () => {
  const accion = (id: string, herramienta: string, extra: Record<string, unknown> = {}) => ({
    id,
    herramienta,
    texto: describirAccion(herramienta, extra),
    inicio: 0,
    detalle: detalleDeAccion(herramienta, extra),
  })
  const tramosDe = (lista: ReturnType<typeof registrarSpawn>) => lista.find(a => a.id === 'ing-1')?.tramos ?? []

  test('las acciones seguidas de la misma herramienta forman un solo tramo', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    for (const id of ['a', 'b', 'c']) lista = iniciarAccion(lista, 'ing-1', accion(id, 'mcp__drive__copy_file'))
    expect(tramosDe(lista).map(t => t.cantidad)).toEqual([3])
    expect(tramosDe(lista)[0]?.nombrePendiente).toBe(undefined)
  })

  test('otra herramienta cierra el tramo anterior y lo deja esperando su nombre', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    lista = iniciarAccion(lista, 'ing-1', accion('a', 'Read', { file_path: '/p/a.kt' }))
    lista = iniciarAccion(lista, 'ing-1', accion('b', 'Edit', { file_path: '/p/a.kt' }))
    const [leer, editar] = tramosDe(lista)
    expect(leer?.cerrado).toBe(true)
    expect(leer?.nombrePendiente).toBe(true)
    expect(editar?.cerrado).toBe(undefined)
  })

  test('un tramo junta como mucho 5 acciones', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    for (let n = 1; n <= 7; n++) lista = iniciarAccion(lista, 'ing-1', accion(`t${n}`, 'Read'))
    expect(tramosDe(lista).map(t => t.cantidad)).toEqual([5, 2])
  })

  test('se guardan los 3 tramos más recientes, el más viejo primero', async () => {
    let lista = registrarSpawn([], spawnIng, 0)
    const herramientas = ['Read', 'Edit', 'Bash', 'Grep', 'Write']
    herramientas.forEach((h, n) => (lista = iniciarAccion(lista, 'ing-1', accion(`t${n}`, h))))
    expect(tramosDe(lista).map(t => t.herramienta)).toEqual(['Bash', 'Grep', 'Write'])
  })

  test('el fin del turno cierra el último tramo', async () => {
    let lista = iniciarAccion(registrarSpawn([], spawnIng, 0), 'ing-1', accion('a', 'Read'))
    lista = terminarTurno(lista, 'ing-1', 'answer', 'ok', 5)
    expect(tramosDe(lista)[0]?.nombrePendiente).toBe(true)
  })

  test('el pedido de nombre lleva la tarea, lo que dijo el agente y los datos de cada acción', async () => {
    let lista = anotarNarracion(registrarSpawn([], spawnIng, 0), 'ing-1', 'Copio la plantilla a la carpeta del proyecto.')
    lista = iniciarAccion(lista, 'ing-1', accion('a', 'mcp__drive__copy_file', { title: 'Plantilla BD', fileId: 'x1' }))
    lista = terminarTurno(lista, 'ing-1', 'answer', 'ok', 5)

    const siguiente = siguienteTramoSinNombre(lista)
    expect(siguiente?.tramo.id).toBe('a')
    const pedido = pedidoDeNombreTramo(siguiente!.agente, siguiente!.tramo)
    expect(pedido).toContain('Base de datos')
    expect(pedido).toContain('Copio la plantilla')
    expect(pedido).toContain('Plantilla BD')
  })

  test('el nombre se guarda limpio, una sola vez, y libera los datos de las acciones', async () => {
    let lista = terminarTurno(iniciarAccion(registrarSpawn([], spawnIng, 0), 'ing-1', accion('a', 'Read')), 'ing-1', 'answer', 'ok', 5)
    lista = marcarTramoPedido(lista, 'ing-1', 'a')
    expect(siguienteTramoSinNombre(lista)).toBe(undefined)

    lista = guardarNombreTramo(lista, 'ing-1', 'a', '"Revisar el modelo de stock."')
    expect(tramosDe(lista)[0]?.nombre).toBe('Revisar el modelo de stock')
    expect(tramosDe(lista)[0]?.detalles).toEqual([])
  })

  test('los datos de una acción se acortan y omiten lo vacío', async () => {
    const detalle = detalleDeAccion('Write', { file_path: '/p/README.md', content: 'x'.repeat(500), vacio: '' })
    expect(detalle).toContain('README.md')
    expect(detalle).not.toContain('vacio')
    expect(detalle.length).toBeLessThanOrEqual(200)
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

  test('un terminado pasa solo al historial cuando pasó un rato, sin borrarse', async () => {
    const lista = armar()
    expect(hayParaArchivar(lista, 9 + ESPERA_ARCHIVO_MS - 1)).toBe(false)
    expect(hayParaArchivar(lista, 9 + ESPERA_ARCHIVO_MS)).toBe(true)

    const archivada = archivarViejos(lista, 9 + ESPERA_ARCHIVO_MS)
    expect(filtrar(archivada, 'todos').map(a => a.id)).toEqual([ID_PRINCIPAL, 'test-1'])
    expect(filtrar(archivada, 'historial').map(a => a.id)).toEqual(['ing-1'])
  })

  test('el principal nunca pasa al historial', async () => {
    const lista = terminarTurno(iniciarTurno([], undefined, 0), undefined, 'answer', 'ok', 1)
    expect(hayParaArchivar(lista, 1 + ESPERA_ARCHIVO_MS * 10)).toBe(false)
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

  test('el rol sale del prefijo de la tarea o del tipo', async () => {
    expect(rolDe({ id: 'x', tipo: 'general-purpose', descripcion: 'ING T7: algo' })).toBe('ING')
    expect(rolDe({ id: 'x', tipo: 'general-purpose', descripcion: 'DOC T14: algo' })).toBe('DOC')
    expect(rolDe({ id: 'x', tipo: 'otro-tipo', descripcion: '' })).toBe('otro-tipo')
  })

  test('si la sesión corre como el architect, el principal se muestra como ARQ', async () => {
    const comoClaude = iniciarTurno([], undefined, 0)
    expect(rolDe(comoClaude.find(a => a.id === ID_PRINCIPAL)!)).toBe('Claude')

    const comoArq = nombrarPrincipal(comoClaude, 'software-architect', 1)
    expect(rolDe(comoArq.find(a => a.id === ID_PRINCIPAL)!)).toBe('ARQ')
    expect(nombrarPrincipal(comoArq, 'software-architect', 2)).toEqual(comoArq)
  })

  test('las duraciones y los tokens se leen cortos', async () => {
    expect(formatearDuracion(147_000)).toBe('2m 27s')
    expect(formatearTokens(4_800)).toBe('4,8k')
    expect(formatearTokens(48_200)).toBe('48k')
  })
})
