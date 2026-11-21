// Modelo del mapa de agentes: funciones puras, sin $ ni dibujo.
// Cada función recibe la lista actual y devuelve una lista nueva (inmutable).

import type { Accion, Agente, EstadoAgente, EstadoPaso, Filtro, PasoPlan } from '../types'

export const ID_PRINCIPAL = 'principal'
const MAX_AGENTES = 80
const MAX_RECIENTES = 3
const MAX_RESPUESTA = 800
const MAX_TEXTO = 48

// ---------- Creación y búsqueda ----------

function agenteNuevo(id: string, ahora: number, datos: Partial<Agente> = {}): Agente {
  return {
    id,
    padreId: id === ID_PRINCIPAL ? undefined : ID_PRINCIPAL,
    tipo: id === ID_PRINCIPAL ? 'principal' : 'agente',
    descripcion: id === ID_PRINCIPAL ? 'Conversación principal' : '',
    estado: 'trabajando',
    inicio: ahora,
    plan: [],
    enCurso: [],
    recientes: [],
    totalAcciones: 0,
    tokens: 0,
    ...datos,
  }
}

/** Aplica `cambio` al agente `id`; si no existe todavía, lo crea primero. */
function conAgente(
  lista: readonly Agente[],
  id: string,
  ahora: number,
  cambio: (agente: Agente) => Agente,
): Agente[] {
  const existe = lista.some(a => a.id === id)
  const base = existe ? [...lista] : [...lista, agenteNuevo(id, ahora)]
  return recortar(base.map(a => (a.id === id ? cambio(a) : a)))
}

/** Mantiene la lista acotada: descarta primero lo más viejo del historial, después terminados. */
function recortar(lista: Agente[]): Agente[] {
  let resultado = lista
  while (resultado.length > MAX_AGENTES) {
    const viejo =
      resultado.find(a => a.archivado === true) ??
      resultado.find(a => a.id !== ID_PRINCIPAL && a.estado !== 'trabajando')
    if (viejo === undefined) break
    resultado = resultado.filter(a => a !== viejo)
  }
  return resultado
}

const idDe = (agentId: string | undefined) => agentId ?? ID_PRINCIPAL

// ---------- Eventos del ciclo de vida ----------

export type DatosSpawn = {
  id: string
  padreId?: string
  tipo: string
  nombre?: string
  descripcion: string
}

/** Un agente creó un subagente. */
export function registrarSpawn(lista: readonly Agente[], datos: DatosSpawn, ahora: number): Agente[] {
  const padreId = idDe(datos.padreId)
  const conPadre = lista.some(a => a.id === padreId) ? [...lista] : conAgente(lista, padreId, ahora, a => a)
  return conAgente(conPadre, datos.id, ahora, a => ({
    ...a,
    padreId,
    tipo: datos.tipo,
    nombre: datos.nombre,
    descripcion: datos.descripcion,
    estado: 'trabajando',
    inicio: ahora,
    fin: undefined,
  }))
}

/** Empieza un turno del agente (o del principal si `agentId` falta). */
export function iniciarTurno(lista: readonly Agente[], agentId: string | undefined, ahora: number): Agente[] {
  return conAgente(lista, idDe(agentId), ahora, a => ({
    ...a,
    estado: 'trabajando',
    fin: undefined,
    archivado: undefined,
    inicio: a.estado === 'trabajando' ? a.inicio : ahora,
  }))
}

export type MotivoFin = 'answer' | 'aborted' | 'refusal' | 'error'

function estadoAlTerminar(esPrincipal: boolean, motivo: MotivoFin): EstadoAgente {
  if (motivo === 'aborted') return 'detenido'
  if (motivo === 'error' || motivo === 'refusal') return 'fallo'
  return esPrincipal ? 'en-espera' : 'terminado'
}

/** Termina un turno: guarda el estado final y la respuesta, y pide su resumen corto. */
export function terminarTurno(
  lista: readonly Agente[],
  agentId: string | undefined,
  motivo: MotivoFin,
  respuesta: string,
  ahora: number,
): Agente[] {
  const id = idDe(agentId)
  const limpia = respuesta.trim()
  return conAgente(lista, id, ahora, a => ({
    ...a,
    estado: estadoAlTerminar(id === ID_PRINCIPAL, motivo),
    fin: ahora,
    enCurso: [],
    resumen: primeraLinea(limpia) ?? a.resumen,
    respuesta: limpia === '' ? a.respuesta : limpia.slice(0, MAX_RESPUESTA),
    resumenCorto: limpia === '' ? a.resumenCorto : undefined,
    resumenPendiente: id !== ID_PRINCIPAL && limpia !== '',
  }))
}

// ---------- Resumen corto ----------

/** El próximo agente al que hay que pedirle el resumen corto, si hay alguno. */
export function siguienteSinResumen(lista: readonly Agente[]): Agente | undefined {
  return lista.find(a => a.resumenPendiente === true && a.respuesta !== undefined)
}

export function marcarResumenPedido(lista: readonly Agente[], id: string): Agente[] {
  return lista.map(a => (a.id === id ? { ...a, resumenPendiente: false } : a))
}

export function guardarResumenCorto(lista: readonly Agente[], id: string, texto: string): Agente[] {
  const frase = limpiarFrase(texto)
  return frase === '' ? [...lista] : lista.map(a => (a.id === id ? { ...a, resumenCorto: frase } : a))
}

/** Lo que se le pide al modelo chico para resumir la respuesta de un agente. */
export function pedidoDeResumen(respuesta: string): string {
  return [
    'Resumí en español, en UNA frase de 3 a 8 palabras, qué hizo o encontró este agente.',
    'Estilo de lista de tareas: simple y concreto, sin comillas, sin punto final, sin explicar.',
    'Ejemplos: "Contó 16 funciones exportadas" · "Los 21 tests pasan" · "Arregló el login".',
    'Respondé solo la frase.',
    '',
    'Respuesta del agente:',
    respuesta,
  ].join('\n')
}

function limpiarFrase(texto: string): string {
  const linea = primeraLinea(texto) ?? ''
  return acortar(linea.replace(/^["'“«\s]+|["'”»\s.]+$/g, ''))
}

// ---------- Plan (lista de tareas del agente) ----------

const HERRAMIENTAS_DE_PLAN = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'mcp__ccd_turn__update_plan',
])

/** Herramientas con las que el agente lleva su lista de tareas: no son pasos de trabajo. */
export const esHerramientaDePlan = (herramienta: string) => HERRAMIENTAS_DE_PLAN.has(herramienta)

const ESTADO_PASO: Record<string, EstadoPaso> = {
  pending: 'pendiente',
  in_progress: 'en-curso',
  completed: 'hecho',
}

type ItemExterno = { content?: unknown; status?: unknown }

const pasoDe = (item: ItemExterno): PasoPlan | undefined =>
  typeof item.content === 'string'
    ? { texto: acortar(item.content), estado: ESTADO_PASO[String(item.status)] ?? 'pendiente' }
    : undefined

/** El plan nuevo después de que el agente usó una herramienta de plan. */
export function planNuevo(plan: readonly PasoPlan[], herramienta: string, args: Record<string, unknown>, resultado?: unknown): PasoPlan[] {
  const conEstado = (i: number, estado: EstadoPaso) => (p: PasoPlan, j: number) => (j === i ? { ...p, estado } : p)

  switch (herramienta) {
    case 'TodoWrite':
      return Array.isArray(args.todos) ? (args.todos as ItemExterno[]).map(pasoDe).filter(esPaso) : [...plan]

    case 'mcp__ccd_turn__update_plan': {
      if (Array.isArray(args.items)) return (args.items as ItemExterno[]).map(pasoDe).filter(esPaso)
      let nuevo = [...plan]
      if (args.advance === true) {
        const actual = nuevo.findIndex(p => p.estado === 'en-curso')
        if (actual >= 0) nuevo = nuevo.map(conEstado(actual, 'hecho'))
        const siguiente = nuevo.findIndex(p => p.estado === 'pendiente')
        if (siguiente >= 0) nuevo = nuevo.map(conEstado(siguiente, 'en-curso'))
      }
      if (Array.isArray(args.done)) {
        for (const n of args.done) if (typeof n === 'number') nuevo = nuevo.map(conEstado(n - 1, 'hecho'))
      }
      if (typeof args.start === 'number') nuevo = nuevo.map(conEstado(args.start - 1, 'en-curso'))
      return nuevo
    }

    case 'TaskCreate': {
      const id = (resultado as { task?: { id?: unknown } } | undefined)?.task?.id
      const texto = typeof args.subject === 'string' ? acortar(args.subject) : undefined
      return texto === undefined ? [...plan] : [...plan, { id: typeof id === 'string' ? id : undefined, texto, estado: 'pendiente' }]
    }

    case 'TaskUpdate': {
      if (args.status === 'deleted') return plan.filter(p => p.id !== args.taskId)
      return plan.map(p =>
        p.id !== args.taskId
          ? p
          : {
              ...p,
              texto: typeof args.subject === 'string' ? acortar(args.subject) : p.texto,
              estado: ESTADO_PASO[String(args.status)] ?? p.estado,
            },
      )
    }

    default:
      return [...plan]
  }
}

const esPaso = (p: PasoPlan | undefined): p is PasoPlan => p !== undefined

export function actualizarPlan(
  lista: readonly Agente[],
  agentId: string | undefined,
  herramienta: string,
  args: Record<string, unknown>,
  resultado: unknown,
  ahora: number,
): Agente[] {
  return conAgente(lista, idDe(agentId), ahora, a => ({
    ...a,
    plan: planNuevo(a.plan ?? [], herramienta, args, resultado),
  }))
}

// ---------- Acciones (llamadas a herramientas) ----------

export function iniciarAccion(lista: readonly Agente[], agentId: string | undefined, accion: Accion): Agente[] {
  return conAgente(lista, idDe(agentId), accion.inicio, a => ({
    ...a,
    estado: 'trabajando',
    enCurso: [...a.enCurso, accion],
    totalAcciones: a.totalAcciones + 1,
  }))
}

export function terminarAccion(
  lista: readonly Agente[],
  agentId: string | undefined,
  accionId: string,
  fallo: boolean,
  ahora: number,
): Agente[] {
  return conAgente(lista, idDe(agentId), ahora, a => {
    const accion = a.enCurso.find(x => x.id === accionId)
    if (accion === undefined) return a
    const terminada: Accion = { ...accion, fin: ahora, fallo }
    return {
      ...a,
      enCurso: a.enCurso.filter(x => x.id !== accionId),
      recientes: [terminada, ...a.recientes].slice(0, MAX_RECIENTES),
    }
  })
}

/** Suma los tokens de un pedido al modelo hecho por el agente. */
export function sumarTokens(lista: readonly Agente[], agentId: string | undefined, tokens: number, ahora: number): Agente[] {
  if (tokens <= 0) return [...lista]
  return conAgente(lista, idDe(agentId), ahora, a => ({ ...a, tokens: (a.tokens ?? 0) + tokens }))
}

/** Total de tokens de un pedido: entrada, salida y lo leído o escrito en caché. */
export function tokensDeUso(uso: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number {
  return uso.input_tokens + uso.output_tokens + uso.cache_read_input_tokens + uso.cache_creation_input_tokens
}

// ---------- Filtros e historial ----------

const esTerminado = (a: Agente) => a.id !== ID_PRINCIPAL && a.estado !== 'trabajando'

/** Mueve al historial los subagentes que ya no trabajan; el principal nunca se archiva. */
export function archivarTerminados(lista: readonly Agente[]): Agente[] {
  return lista.map(a => (esTerminado(a) && a.archivado !== true ? { ...a, archivado: true } : a))
}

/** Los agentes que muestra cada filtro. */
export function filtrar(lista: readonly Agente[], filtro: Filtro): Agente[] {
  switch (filtro) {
    case 'historial':
      return lista.filter(a => a.archivado === true)
    case 'en-curso':
      return lista.filter(a => a.archivado !== true && a.estado === 'trabajando')
    case 'terminados':
      return lista.filter(a => a.archivado !== true && esTerminado(a))
    default:
      return lista.filter(a => a.archivado !== true)
  }
}

/** Cuántos agentes hay en cada filtro (sin contar al principal en "todos"). */
export function contar(lista: readonly Agente[]): Record<Filtro, number> {
  return {
    todos: filtrar(lista, 'todos').filter(a => a.id !== ID_PRINCIPAL).length,
    'en-curso': filtrar(lista, 'en-curso').filter(a => a.id !== ID_PRINCIPAL).length,
    terminados: filtrar(lista, 'terminados').length,
    historial: filtrar(lista, 'historial').length,
  }
}

const FILTROS: readonly Filtro[] = ['todos', 'en-curso', 'terminados', 'historial']

/** Un filtro guardado que no es válido se lee como "todos". */
export const filtroValido = (valor: unknown): Filtro =>
  FILTROS.includes(valor as Filtro) ? (valor as Filtro) : 'todos'

/** Tocar el filtro activo vuelve a "todos". */
export const elegirFiltro = (actual: Filtro, tocado: Filtro): Filtro => (actual === tocado ? 'todos' : tocado)

// ---------- Lectura para el panel ----------

export type Fila = { agente: Agente; profundidad: number }

/** Ordena la lista como árbol: cada agente debajo de quien lo creó. */
export function comoArbol(lista: readonly Agente[]): Fila[] {
  const ids = new Set(lista.map(a => a.id))
  const esRaiz = (a: Agente) => a.padreId === undefined || !ids.has(a.padreId)
  const hijos = (padreId: string) => lista.filter(a => a.padreId === padreId && !esRaiz(a))

  const filas: Fila[] = []
  const visitar = (agente: Agente, profundidad: number) => {
    filas.push({ agente, profundidad })
    hijos(agente.id).forEach(h => visitar(h, profundidad + 1))
  }
  lista.filter(esRaiz).forEach(r => visitar(r, 0))
  return filas
}

export type Avatar = { emoji: string; rol: string }

/** El avatar sale del prefijo de la tarea (ARQ/ING/TEST) o del tipo de agente. */
export function avatarDe(agente: Pick<Agente, 'id' | 'tipo' | 'descripcion'>): Avatar {
  if (agente.id === ID_PRINCIPAL) return { emoji: '🧠', rol: 'Claude' }
  const prefijo = /^(ARQ|ING|TEST)\b/i.exec(agente.descripcion)?.[1]?.toUpperCase()
  const clave = prefijo ?? agente.tipo
  const avatares: Record<string, Avatar> = {
    ARQ: { emoji: '🧭', rol: 'ARQ' },
    'software-architect': { emoji: '🧭', rol: 'ARQ' },
    ING: { emoji: '🔨', rol: 'ING' },
    'software-engineer': { emoji: '🔨', rol: 'ING' },
    TEST: { emoji: '🧪', rol: 'TEST' },
    'software-tester': { emoji: '🧪', rol: 'TEST' },
    Explore: { emoji: '🔎', rol: 'Explorar' },
    Plan: { emoji: '📐', rol: 'Plan' },
    fork: { emoji: '🌿', rol: 'Fork' },
  }
  return avatares[clave] ?? { emoji: '🤖', rol: agente.tipo }
}

/** Nombre corto de la herramienta: `mcp__servidor__accion` se muestra como `accion`. */
export function nombreCorto(herramienta: string): string {
  return herramienta.startsWith('mcp__') ? (herramienta.split('__').pop() ?? herramienta) : herramienta
}

/** El paso contado como una tarea corta, al estilo de la lista de la app ("Leer Main.kt"). */
export function describirAccion(herramienta: string, args: Record<string, unknown>): string {
  const texto = (clave: string) => (typeof args[clave] === 'string' ? (args[clave] as string) : undefined)
  const archivo = (clave: string) => texto(clave)?.split(/[\\/]/).pop()
  const con = (verbo: string, que: string | undefined) => (que ? `${verbo} ${que}` : verbo)

  const frase = (() => {
    switch (herramienta) {
      case 'Bash':
      case 'PowerShell':
        return texto('description') ?? fraseDeComando(texto('command') ?? '')
      case 'Read':
        return con('Leer', archivo('file_path'))
      case 'Edit':
      case 'NotebookEdit':
        return con('Editar', archivo('file_path') ?? archivo('notebook_path'))
      case 'Write':
        return con('Crear', archivo('file_path'))
      case 'Grep':
        return con('Buscar', texto('pattern') && `«${texto('pattern')}»`)
      case 'Glob':
        return 'Buscar archivos'
      case 'Agent':
      case 'Task':
        return con('Delegar:', texto('description') && tareaLegible(texto('description') ?? ''))
      case 'WebFetch':
        return con('Leer la página', hostDe(texto('url')))
      case 'WebSearch':
        return con('Buscar en la web:', texto('query'))
      case 'Skill':
        return con('Usar la skill', texto('skill'))
      case 'SendMessage':
        return 'Enviar un mensaje'
      default:
        return `Usar ${nombreCorto(herramienta)}`
    }
  })()
  const linea = primeraLinea(frase) ?? frase
  return acortar(linea.charAt(0).toUpperCase() + linea.slice(1))
}

/** Para un comando sin descripción: qué hace, por las palabras que tiene. */
function fraseDeComando(comando: string): string {
  const reglas: [RegExp, string][] = [
    [/\btest\b|pytest|jest|vitest/i, 'Correr los tests'],
    [/build|gradlew|compile|tsc\b/i, 'Compilar el proyecto'],
    [/git\s+commit/i, 'Hacer un commit'],
    [/git\s+(status|diff|log)/i, 'Revisar los cambios'],
    [/\b(npm|pip|yarn|pnpm)\s+(i|install|add)\b/i, 'Instalar dependencias'],
    [/^\s*(ls|dir|Get-ChildItem)\b/i, 'Listar archivos'],
    [/^\s*(cat|type|Get-Content|head|tail)\b/i, 'Leer un archivo'],
    [/^\s*(sleep|Start-Sleep)\b/i, 'Esperar'],
  ]
  return reglas.find(([patron]) => patron.test(comando))?.[1] ?? 'Ejecutar un comando'
}

/** La tarea sin el código del rol ("ING T7: preparar…" → "Preparar…"). */
export function tareaLegible(descripcion: string): string {
  const sinPrefijo = descripcion.replace(/^\s*(ARQ|ING|TEST)(\s+T?\d+)?\s*[:\-–]\s*/i, '').trim()
  return acortar(sinPrefijo.charAt(0).toUpperCase() + sinPrefijo.slice(1))
}

function hostDe(url: string | undefined): string | undefined {
  return url?.replace(/^https?:\/\//, '').split('/')[0]
}

function acortar(texto: string): string {
  return texto.length <= MAX_TEXTO ? texto : `${texto.slice(0, MAX_TEXTO - 1).trimEnd()}…`
}

/** 4s · 2m 27s · 1h 3m */
export function formatearDuracion(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 850 · 4,8k · 48k · 1,2M */
export function formatearTokens(n: number): string {
  const decimal = (x: number) => x.toFixed(1).replace('.', ',').replace(/,0$/, '')
  if (n < 1000) return `${n}`
  if (n < 10_000) return `${decimal(n / 1000)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${decimal(n / 1_000_000)}M`
}

function primeraLinea(texto: string): string | undefined {
  const linea = texto
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)
  return linea === undefined ? undefined : linea.slice(0, 160)
}
