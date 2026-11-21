// Mapa de agentes: escucha los eventos de los agentes (bordes) y los dibuja en un panel.
// Las reglas viven en ./modelo.ts; acá solo se conectan eventos -> modelo -> panel.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Accion, Agente, EstadoAgente, Filtro, PasoPlan } from '../types'
import {
  ID_PRINCIPAL,
  actualizarPlan,
  archivarTerminados,
  avatarDe,
  comoArbol,
  contar,
  describirAccion,
  elegirFiltro,
  esHerramientaDePlan,
  filtrar,
  filtroValido,
  formatearDuracion,
  formatearTokens,
  guardarResumenCorto,
  iniciarAccion,
  iniciarTurno,
  marcarResumenPedido,
  pedidoDeResumen,
  registrarSpawn,
  siguienteSinResumen,
  sumarTokens,
  tareaLegible,
  terminarAccion,
  terminarTurno,
  tokensDeUso,
} from './modelo'

const PANEL = 'mapa-agentes'
const TITULO = 'Mapa de agentes'
const MODELO_RESUMEN = 'haiku'

// Cambiar el `shape` cuando cambien los campos de Agente: descarta lo guardado por una versión vieja.
const agentes = atom({ plugin: 'mapa-agentes', key: 'agentes' } as const, [], { shape: 'agentes-4' })
// Se actualiza cada segundo mientras alguien trabaja, para que avancen los cronómetros.
const reloj = atom({ plugin: 'mapa-agentes', key: 'reloj' } as const, 0)
const filtroActivo = atom({ plugin: 'mapa-agentes', key: 'filtro' } as const, 'todos' as Filtro)
// Cuántas acciones recientes se ven en cada tarjeta.
const ACCIONES_A_LA_VISTA = 3
// Debajo de estos anchos (en columnas de texto) el panel pasa a modo compacto y mini.
const ANCHO_COMPACTO = 48
const ANCHO_MINI = 34

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

const ESTADO: Record<EstadoAgente, { color: string; etiqueta: string }> = {
  trabajando: { color: 'claude', etiqueta: '◌ Trabajando' },
  'en-espera': { color: 'subtle', etiqueta: '○ Esperándote' },
  terminado: { color: 'success', etiqueta: '✓ Terminado' },
  fallo: { color: 'error', etiqueta: '✕ Falló' },
  detenido: { color: 'warning', etiqueta: '■ Detenido' },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agentes', description: 'Abre el mapa de agentes en un panel lateral' })
    void $.ui.open({ id: PANEL, title: TITULO })

    // Pide de a uno el resumen corto de los agentes que terminaron.
    let resumiendo = false
    const resumirPendientes = async () => {
      if (resumiendo) return
      const agente = siguienteSinResumen(await read($, agentes))
      if (agente === undefined) return
      resumiendo = true
      try {
        await update($, agentes, lista => marcarResumenPedido(lista, agente.id))
        const r = await $.model.complete({
          model: MODELO_RESUMEN,
          prompt: pedidoDeResumen(agente.respuesta ?? ''),
          maxTokens: 60,
        })
        if (r.isAnswered) await update($, agentes, lista => guardarResumenCorto(lista, agente.id, r.text))
      } finally {
        resumiendo = false
      }
    }

    $.clock.every(1000, () => {
      void (async () => {
        const lista = await read($, agentes)
        if (lista.some(a => a.estado === 'trabajando')) {
          const ahora = await $.clock.now()
          await update($, reloj, () => ahora)
        }
        await resumirPendientes()
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'agentes' }, async $ => {
    await $.ui.open({ id: PANEL, title: TITULO })
    return { text: 'Mapa de agentes abierto.' }
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
    return next(e)
  })

  // Cada pedido al modelo informa los tokens que usó: se suman al agente que lo hizo.
  on('turn.step', async function* ($, e, next) {
    const respuesta = yield* next(e)
    if (respuesta.usage !== null) {
      const tokens = tokensDeUso(respuesta.usage)
      const ahora = await $.clock.now()
      await update($, agentes, lista => sumarTokens(lista, e.agentId, tokens, ahora))
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

    // El diseño se adapta al ancho del panel: angosto = sin avatar en caja, todo en columna.
    const ancho = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    const compacto = ancho < ANCHO_COMPACTO
    const mini = ancho < ANCHO_MINI

    const cuenta = contar(lista)
    const enVivo = lista.some(a => a.estado === 'trabajando')
    const visibles = filtrar(lista, filtro)

    const botonFiltro = (f: Filtro, texto: string) => (
      <Button
        key={`filtro-${f}`}
        variant={filtro === f ? 'primary' : 'secondary'}
        onPress={() => void update($, filtroActivo, actual => elegirFiltro(filtroValido(actual), f))}
      >
        {texto}
      </Button>
    )

    // Una línea de puntos, como la lista de tareas de la app.
    const lineaDePuntos = (
      filas: { clave: string; marca: string; color: string; texto: string; activo: boolean; tenue: boolean; derecha?: string }[],
    ) => (
      <Box flexDirection="column" paddingLeft={1}>
        {filas.map((fila, i) => (
          <Box key={fila.clave} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={fila.color}>{fila.marca}</Text>
              <Box flexGrow={1}>
                <Text bold={fila.activo} dimColor={fila.tenue} wrap="truncate-end">
                  {fila.texto}
                </Text>
              </Box>
              {fila.derecha !== undefined && !compacto && <Text dimColor>{fila.derecha}</Text>}
            </Box>
            {i < filas.length - 1 && <Text dimColor>│</Text>}
          </Box>
        ))}
      </Box>
    )

    const filasDePlan = (plan: readonly PasoPlan[]) =>
      plan.map((paso, i) => ({
        clave: `plan-${i}`,
        marca: paso.estado === 'hecho' ? '●' : paso.estado === 'en-curso' ? '◉' : '○',
        color: paso.estado === 'hecho' ? 'success' : paso.estado === 'en-curso' ? 'claude' : 'subtle',
        texto: paso.texto,
        activo: paso.estado === 'en-curso',
        tenue: paso.estado !== 'en-curso',
      }))

    const filasDeAcciones = (agente: Agente) => {
      const terminadas = agente.recientes.slice(0, ACCIONES_A_LA_VISTA)
      const acciones: Accion[] = [...terminadas].reverse().concat(agente.enCurso)
      return acciones.map(accion => {
        const actual = accion.fin === undefined
        return {
          clave: accion.id,
          marca: actual ? '◉' : accion.fallo === true ? '✕' : '●',
          color: actual ? 'claude' : accion.fallo === true ? 'error' : 'success',
          texto: accion.texto,
          activo: actual,
          tenue: !actual,
          derecha: formatearDuracion((accion.fin ?? ahora) - accion.inicio),
        }
      })
    }

    // Si el agente escribió su lista de tareas, se muestra esa; si no, sus últimas acciones.
    const pasos = (agente: Agente) => {
      const plan = agente.plan ?? []
      if (plan.length > 0) return lineaDePuntos(filasDePlan(plan))
      const acciones = filasDeAcciones(agente)
      if (acciones.length > 0) return lineaDePuntos(acciones)
      return agente.estado === 'trabajando' ? <Text dimColor>◌ Arrancando…</Text> : null
    }

    const resumen = (agente: Agente) => {
      if (agente.id === ID_PRINCIPAL || agente.estado === 'trabajando') return null
      const texto = agente.resumenCorto ?? (agente.resumenPendiente === true ? 'Resumiendo…' : agente.resumen)
      if (texto === undefined) return null
      return (
        <Box flexDirection={compacto ? 'column' : 'row'} gap={compacto ? 0 : 1}>
          <Text bold>Resumen:</Text>
          <Box flexGrow={1}>
            <Text dimColor={agente.resumenCorto === undefined}>{texto}</Text>
          </Box>
        </Box>
      )
    }

    const tarjeta = (agente: Agente, profundidad: number) => {
      const avatar = avatarDe(agente)
      const estado = ESTADO[agente.estado]
      const esPrincipal = agente.id === ID_PRINCIPAL
      const tarea = esPrincipal ? 'Conversación principal' : tareaLegible(agente.descripcion)
      const duracion = formatearDuracion((agente.fin ?? ahora) - agente.inicio)

      return (
        <Box
          key={agente.id}
          flexDirection="column"
          gap={1}
          borderStyle="round"
          borderColor={agente.estado === 'trabajando' ? estado.color : undefined}
          borderDimColor={agente.estado !== 'trabajando'}
          paddingX={compacto ? 1 : 2}
          paddingY={compacto ? 0 : 1}
          marginLeft={Math.min(profundidad, compacto ? 2 : 4) * (compacto ? 1 : 2)}
        >
          {compacto ? (
            <Box flexDirection="column">
              <Text bold wrap="truncate-end">
                {avatar.emoji} {avatar.rol}
                {agente.nombre !== undefined ? ` · ${agente.nombre}` : ''}
              </Text>
              <Text color={estado.color}>{estado.etiqueta}</Text>
              {tarea !== '' && <Text dimColor>{tarea}</Text>}
            </Box>
          ) : (
            <Box flexDirection="row" gap={2} alignItems="center">
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text>{avatar.emoji}</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexShrink={1}>
                    <Text bold size="heading" wrap="truncate-end">
                      {avatar.rol}
                      {agente.nombre !== undefined ? ` · ${agente.nombre}` : ''}
                    </Text>
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
            </Box>
          )}

          {pasos(agente)}
          {resumen(agente)}

          <Text dimColor>
            {compacto
              ? `⏱ ${duracion} · ${formatearTokens(agente.tokens ?? 0)} tok`
              : `⏱ ${duracion} · ${plural(agente.totalAcciones, 'acción', 'acciones')} · ${formatearTokens(agente.tokens ?? 0)} tokens`}
          </Text>
        </Box>
      )
    }

    const vacio: Record<Filtro, [string, string]> = {
      todos: ['Sin agentes todavía', 'Cuando un agente empiece a trabajar, aparece acá.'],
      'en-curso': ['Nadie trabajando ahora', 'Tocá el filtro otra vez para ver todos.'],
      terminados: ['Ningún agente terminado', 'Tocá el filtro otra vez para ver todos.'],
      historial: ['El historial está vacío', '"Limpiar terminados" guarda acá los agentes que terminaron.'],
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={compacto ? 0 : 1} paddingY={compacto ? 0 : 1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text color={enVivo ? 'success' : 'subtle'}>
              {mini ? (enVivo ? '●' : '○') : enVivo ? '● En vivo' : '○ En pausa'}
            </Text>
          </Box>
          {botonFiltro('todos', mini ? `👥 ${cuenta.todos}` : `👥 ${plural(cuenta.todos, 'agente', 'agentes')}`)}
          {botonFiltro(
            'terminados',
            mini ? `✓ ${cuenta.terminados}` : `✓ ${plural(cuenta.terminados, 'terminado', 'terminados')}`,
          )}
          {botonFiltro('en-curso', mini ? `◌ ${cuenta['en-curso']}` : `◌ ${cuenta['en-curso']} en curso`)}
          {(cuenta.historial > 0 || filtro === 'historial') &&
            botonFiltro('historial', mini ? `🕘 ${cuenta.historial}` : `🕘 Historial · ${cuenta.historial}`)}
        </Box>

        {visibles.length === 0 && (
          <Box flexDirection="column" paddingY={1}>
            <Text bold>{vacio[filtro][0]}</Text>
            <Text dimColor>{vacio[filtro][1]}</Text>
          </Box>
        )}

        {comoArbol(visibles).map(fila => tarjeta(fila.agente, fila.profundidad))}

        {filtro !== 'historial' && cuenta.terminados > 0 && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="limpiar" onPress={() => void update($, agentes, archivarTerminados)}>
              Limpiar terminados
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
