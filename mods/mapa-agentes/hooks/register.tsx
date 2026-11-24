// Mapa de agentes: escucha los eventos de los agentes (bordes) y los dibuja en un panel.
// Las reglas viven en ./modelo.ts; acá solo se conectan eventos -> modelo -> panel.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agente, EstadoAgente, Filtro, PasoPlan, Tramo } from '../types'
import {
  ID_PRINCIPAL,
  actualizarPlan,
  anotarNarracion,
  archivarViejos,
  comoArbol,
  contar,
  describirAccion,
  detalleDeAccion,
  elegirFiltro,
  esHerramientaDePlan,
  filtrar,
  filtroValido,
  formatearDuracion,
  formatearTokens,
  guardarNombreTramo,
  guardarResumenCorto,
  hayParaArchivar,
  iniciarAccion,
  iniciarTurno,
  marcarResumenPedido,
  marcarTramoPedido,
  nombrarPrincipal,
  pedidoDeNombreTramo,
  pedidoDeResumen,
  registrarSpawn,
  rolDe,
  siguienteSinResumen,
  siguienteTramoSinNombre,
  sumarTokens,
  tareaLegible,
  terminarAccion,
  terminarTurno,
  tokensDeUso,
} from './modelo'

const PANEL = 'mapa-agentes'
const TITULO = 'Mapa de agentes'
const MODELO_CHICO = 'haiku'
// Cuántos pedidos al modelo chico pueden estar en curso a la vez.
const PEDIDOS_A_LA_VEZ = 3
// Se guarda entre sesiones: el panel quedó cerrado (con /agentes o a mano).
const CLAVE_CERRADO = 'panelCerrado'

// Cambiar el `shape` cuando cambien los campos de Agente: descarta lo guardado por una versión vieja.
const agentes = atom({ plugin: 'mapa-agentes', key: 'agentes' } as const, [], { shape: 'agentes-5' })
// Se actualiza cada segundo mientras alguien trabaja, para que avancen los cronómetros.
const reloj = atom({ plugin: 'mapa-agentes', key: 'reloj' } as const, 0)
const filtroActivo = atom({ plugin: 'mapa-agentes', key: 'filtro' } as const, 'todos' as Filtro)
// Debajo de estos anchos (en columnas de texto) el panel pasa a modo compacto y mini.
const ANCHO_COMPACTO = 48
const ANCHO_MINI = 34

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

const ESTADO: Record<EstadoAgente, { color: string; etiqueta: string }> = {
  trabajando: { color: 'claude', etiqueta: '● Trabajando' },
  'en-espera': { color: 'subtle', etiqueta: '○ Esperándote' },
  terminado: { color: 'success', etiqueta: '✓ Terminado' },
  fallo: { color: 'error', etiqueta: '✕ Falló' },
  detenido: { color: 'warning', etiqueta: '■ Detenido' },
}

type FilaDePaso = {
  clave: string
  marca: string
  color: string
  texto: string
  activo: boolean
  tenue: boolean
  derecha?: string
}

/** Si la sesión corre como un agente (por ejemplo, el architect), el principal toma ese rol. */
async function rolDeLaSesion($: EngineInterface): Promise<void> {
  try {
    const { agentType } = await $.session.info()
    const ahora = await $.clock.now()
    await update($, agentes, lista => nombrarPrincipal(lista, agentType, ahora))
  } catch {
    // Sin datos de la sesión, el principal queda como Claude.
  }
}

/** Guarda si el panel quedó cerrado; si no se puede guardar, sigue sin romper nada. */
async function recordarCerrado($: EngineInterface, cerrado: boolean): Promise<void> {
  await $.store.set(CLAVE_CERRADO, cerrado).catch(() => undefined)
}

/** Una frase del modelo chico, o nada si no contestó: entonces queda el texto provisorio. */
async function pedirFrase($: EngineInterface, prompt: string): Promise<string | undefined> {
  try {
    const r = await $.model.complete({ model: MODELO_CHICO, prompt, maxTokens: 60 })
    return r.isAnswered ? r.text : undefined
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agentes', description: 'Abre o cierra el mapa de agentes' })
    // Si no se puede leer la preferencia, el panel abre igual.
    const cerrado = await $.store.get(CLAVE_CERRADO).catch(() => undefined)
    if (cerrado !== true) void $.ui.open({ id: PANEL, title: TITULO })
    void rolDeLaSesion($)

    // Pide al modelo chico, de a pocos, los nombres de los tramos y los resúmenes pendientes.
    let enVuelo = 0
    let revisando = false
    const atenderPendientes = async () => {
      if (revisando) return
      revisando = true
      try {
        while (enVuelo < PEDIDOS_A_LA_VEZ) {
          const lista = await read($, agentes)
          const pendiente = siguienteTramoSinNombre(lista)
          const sinResumen = pendiente === undefined ? siguienteSinResumen(lista) : undefined

          if (pendiente !== undefined) {
            const { agente, tramo } = pendiente
            await update($, agentes, l => marcarTramoPedido(l, agente.id, tramo.id))
            enVuelo++
            void pedirFrase($, pedidoDeNombreTramo(agente, tramo)).then(async texto => {
              enVuelo--
              if (texto !== undefined) await update($, agentes, l => guardarNombreTramo(l, agente.id, tramo.id, texto))
            })
          } else if (sinResumen !== undefined) {
            await update($, agentes, l => marcarResumenPedido(l, sinResumen.id))
            enVuelo++
            void pedirFrase($, pedidoDeResumen(sinResumen.respuesta ?? '')).then(async texto => {
              enVuelo--
              if (texto !== undefined) await update($, agentes, l => guardarResumenCorto(l, sinResumen.id, texto))
            })
          } else {
            return
          }
        }
      } finally {
        revisando = false
      }
    }

    $.clock.every(1000, () => {
      void (async () => {
        const lista = await read($, agentes)
        const ahora = await $.clock.now()
        if (lista.some(a => a.estado === 'trabajando')) await update($, reloj, () => ahora)
        if (hayParaArchivar(lista, ahora)) await update($, agentes, l => archivarViejos(l, ahora))
        await atenderPendientes()
      })()
    })

    return next(e)
  })

  // /agentes abre el panel si está cerrado y lo cierra si está abierto; la elección se recuerda.
  on('command.run', { command: 'agentes' }, async $ => {
    const abierto = (await $.ui.panes()).some(p => p.id === PANEL)
    await recordarCerrado($, abierto)
    if (abierto) {
      await $.ui.close({ id: PANEL })
      return { text: 'Mapa de agentes cerrado. /agentes lo vuelve a abrir.' }
    }
    await $.ui.open({ id: PANEL, title: TITULO })
    return { text: 'Mapa de agentes abierto. /agentes lo cierra.' }
  })

  // Cerrarlo a mano también se recuerda; el cierre pasa primero, guardar nunca lo frena.
  on('ui.close', async ($, e, next) => {
    const cerrado = await next(e)
    if (e.id === PANEL && e.origin.kind === 'person') await recordarCerrado($, true)
    return cerrado
  })

  on('agent.spawn', async ($, e, next) => {
    const creado = await next(e)
    if (creado.deny === undefined && creado.agentId !== undefined) {
      const datos = {
        id: creado.agentId,
        padreId: e.parentAgentId,
        tipo: e.subagentType,
        nombre: e.name,
        descripcion: e.description,
      }
      const ahora = await $.clock.now()
      await update($, agentes, lista => registrarSpawn(lista, datos, ahora))
    }
    return creado
  })

  on('turn.start', async ($, e, next) => {
    const ahora = await $.clock.now()
    await update($, agentes, lista => iniciarTurno(lista, e.agentId, ahora))
    if (e.agentId === undefined) void rolDeLaSesion($)
    return next(e)
  })

  // Cada pedido al modelo informa sus tokens y lo que dijo el agente antes de usar herramientas.
  on('turn.step', async function* ($, e, next) {
    const respuesta = yield* next(e)
    const ahora = await $.clock.now()
    if (respuesta.usage !== null) {
      const tokens = tokensDeUso(respuesta.usage)
      await update($, agentes, lista => sumarTokens(lista, e.agentId, tokens, ahora))
    }
    if (respuesta.toolUses.length > 0 && respuesta.answer.trim() !== '') {
      await update($, agentes, lista => anotarNarracion(lista, e.agentId, respuesta.answer))
    }
    return respuesta
  })

  on('turn.complete', async ($, e, next) => {
    const ahora = await $.clock.now()
    await update($, agentes, lista => terminarTurno(lista, e.agentId, e.reason, e.answer, ahora))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>

    // La lista de tareas del agente no es un paso de trabajo: actualiza su plan.
    if (esHerramientaDePlan(e.tool)) {
      const resultado = await next(e)
      if (resultado.deny === undefined) {
        const ahora = await $.clock.now()
        await update($, agentes, lista => actualizarPlan(lista, e.agentId, e.tool, args, resultado.result, ahora))
      }
      return resultado
    }

    const accion = {
      id: e.tool_use_id,
      herramienta: e.tool,
      texto: describirAccion(e.tool, args),
      detalle: detalleDeAccion(e.tool, args),
      inicio: await $.clock.now(),
    }
    await update($, agentes, lista => iniciarAccion(lista, e.agentId, accion))

    const resultado = await next(e)

    const fallo = resultado.deny !== undefined || resultado.isError === true
    const ahora = await $.clock.now()
    await update($, agentes, lista => terminarAccion(lista, e.agentId, accion.id, fallo, ahora))
    return resultado
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const lista = await read($, agentes)
    await read($, reloj) // suscribe el panel al tic del reloj
    const filtro = filtroValido(await read($, filtroActivo))
    const ahora = await $.clock.now()

    // El diseño se adapta al ancho del panel.
    const ancho = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    const compacto = ancho < ANCHO_COMPACTO
    const mini = ancho < ANCHO_MINI

    const cuenta = contar(lista)
    const enVivo = lista.some(a => a.estado === 'trabajando')
    const visibles = filtrar(lista, filtro)

    const botonFiltro = (f: Filtro, texto: string, n: number) => (
      <Button
        key={`filtro-${f}`}
        variant={filtro === f ? 'primary' : 'secondary'}
        onPress={() => void update($, filtroActivo, actual => elegirFiltro(filtroValido(actual), f))}
      >
        {mini ? `${texto.charAt(0)} ${n}` : `${texto} ${n}`}
      </Button>
    )

    // Los pasos en una columna de puntos, como la lista de tareas de la app.
    const columnaDePasos = (filas: FilaDePaso[]) => (
      <Box flexDirection="column">
        {filas.map(fila => (
          <Box key={fila.clave} flexDirection="row" gap={1}>
            <Text color={fila.color}>{fila.marca}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold={fila.activo} dimColor={fila.tenue} wrap="truncate-end">
                {fila.texto}
              </Text>
            </Box>
            {fila.derecha !== undefined && !compacto && <Text dimColor>{fila.derecha}</Text>}
          </Box>
        ))}
      </Box>
    )

    const filasDePlan = (plan: readonly PasoPlan[]): FilaDePaso[] =>
      plan.map((paso, i) => ({
        clave: `plan-${i}`,
        marca: paso.estado === 'hecho' ? '●' : paso.estado === 'en-curso' ? '◉' : '○',
        color: paso.estado === 'hecho' ? 'success' : paso.estado === 'en-curso' ? 'claude' : 'subtle',
        texto: paso.texto,
        activo: paso.estado === 'en-curso',
        tenue: paso.estado !== 'en-curso',
      }))

    const filasDeTramos = (agente: Agente): FilaDePaso[] =>
      (agente.tramos ?? []).map((tramo: Tramo) => {
        const actual = tramo.cerrado !== true && agente.estado === 'trabajando'
        const duracion = formatearDuracion((tramo.fin ?? ahora) - tramo.inicio)
        return {
          clave: tramo.id,
          marca: actual ? '◉' : tramo.fallo === true ? '✕' : '●',
          color: actual ? 'claude' : tramo.fallo === true ? 'error' : 'success',
          texto: tramo.nombre ?? tramo.texto,
          activo: actual,
          tenue: !actual,
          derecha: tramo.cantidad > 1 ? `×${tramo.cantidad} · ${duracion}` : duracion,
        }
      })

    // Si el agente escribió su lista de tareas, se muestra esa; si no, sus últimos tramos de trabajo.
    const pasos = (agente: Agente) => {
      const plan = agente.plan ?? []
      if (plan.length > 0) return columnaDePasos(filasDePlan(plan))
      const tramos = filasDeTramos(agente)
      if (tramos.length > 0) return columnaDePasos(tramos)
      return agente.estado === 'trabajando' ? <Text dimColor>Arrancando…</Text> : null
    }

    const resumen = (agente: Agente) => {
      if (agente.id === ID_PRINCIPAL || agente.estado === 'trabajando') return null
      const texto = agente.resumenCorto ?? (agente.resumenPendiente === true ? 'Resumiendo…' : agente.resumen)
      if (texto === undefined) return null
      return (
        <Box flexDirection={compacto ? 'column' : 'row'} gap={compacto ? 0 : 1}>
          <Text bold>Resumen:</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor={agente.resumenCorto === undefined}>{texto}</Text>
          </Box>
        </Box>
      )
    }

    // La jerarquía se lee en la cabecera ("ING  de ARQ"), sin cajas ni sangrías.
    const quienLoCreo = (agente: Agente) => {
      if (agente.padreId === undefined) return undefined
      const padre = lista.find(a => a.id === agente.padreId)
      return padre === undefined ? undefined : rolDe(padre)
    }

    const bloque = (agente: Agente) => {
      const rol = rolDe(agente)
      const estado = ESTADO[agente.estado]
      const esPrincipal = agente.id === ID_PRINCIPAL
      const tarea = esPrincipal ? 'Sesión principal' : tareaLegible(agente.descripcion)
      const padre = quienLoCreo(agente)
      const duracion = formatearDuracion((agente.fin ?? ahora) - agente.inicio)
      const tokens = formatearTokens(agente.tokens ?? 0)

      return (
        <Box key={agente.id} flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Box flexDirection={compacto ? 'column' : 'row'} justifyContent="space-between" gap={compacto ? 0 : 1}>
              <Box flexDirection="row" gap={1} flexShrink={1}>
                <Text bold size="heading" wrap="truncate-end">
                  {rol}
                  {agente.nombre !== undefined ? ` · ${agente.nombre}` : ''}
                </Text>
                {padre !== undefined && <Text dimColor>de {padre}</Text>}
              </Box>
              <Box flexShrink={0}>
                <Text color={estado.color}>{estado.etiqueta}</Text>
              </Box>
            </Box>
            {tarea !== '' && (
              <Text dimColor wrap="truncate-end">
                {tarea}
              </Text>
            )}
          </Box>

          {pasos(agente)}
          {resumen(agente)}

          <Text dimColor>
            {compacto
              ? `${duracion} · ${tokens} tok`
              : `${duracion} · ${plural(agente.totalAcciones, 'acción', 'acciones')} · ${tokens} tokens`}
          </Text>
        </Box>
      )
    }

    const vacio: Record<Filtro, [string, string]> = {
      todos: ['Sin agentes todavía', 'Cuando un agente empiece a trabajar, aparece acá.'],
      'en-curso': ['Nadie trabajando ahora', 'Tocá el filtro otra vez para ver todos.'],
      terminados: ['Ningún agente terminado', 'Tocá el filtro otra vez para ver todos.'],
      historial: ['El historial está vacío', 'Los agentes terminados pasan acá solos a los 5 minutos.'],
    }

    return (
      <Box flexDirection="column" gap={2} paddingX={compacto ? 0 : 1} paddingY={compacto ? 0 : 1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Text color={enVivo ? 'success' : 'subtle'}>{mini ? (enVivo ? '●' : '○') : enVivo ? '● En vivo' : '○ En pausa'}</Text>
          {botonFiltro('todos', 'Todos', cuenta.todos)}
          {botonFiltro('en-curso', 'En curso', cuenta['en-curso'])}
          {botonFiltro('terminados', 'Terminados', cuenta.terminados)}
          {(cuenta.historial > 0 || filtro === 'historial') && botonFiltro('historial', 'Historial', cuenta.historial)}
        </Box>

        {visibles.length === 0 && (
          <Box flexDirection="column">
            <Text bold>{vacio[filtro][0]}</Text>
            <Text dimColor>{vacio[filtro][1]}</Text>
          </Box>
        )}

        {comoArbol(visibles).map(fila => bloque(fila.agente))}
      </Box>
    )
  })
}
