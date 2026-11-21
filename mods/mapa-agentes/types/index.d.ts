// Contrato de lo que el mod guarda en $.state (sobrevive a las recargas del mod).

/** En qué anda un agente. "en-espera" es el principal esperando al usuario. */
export type EstadoAgente = 'trabajando' | 'en-espera' | 'terminado' | 'fallo' | 'detenido'

/** Una llamada a una herramienta, contada como una tarea corta ("Leer Main.kt"). */
export type Accion = {
  id: string
  herramienta: string
  texto: string
  inicio: number
  fin?: number
  fallo?: boolean
}

export type EstadoPaso = 'pendiente' | 'en-curso' | 'hecho'

/** Un paso de la lista de tareas que el propio agente escribe (como la de la app). */
export type PasoPlan = { id?: string; texto: string; estado: EstadoPaso }

/** Un agente de la sesión: el principal ("principal") o un subagente. */
export type Agente = {
  id: string
  padreId?: string
  tipo: string
  nombre?: string
  /** La tarea tal como la escribió quien delegó (de acá sale el rol del avatar). */
  descripcion: string
  estado: EstadoAgente
  inicio: number
  fin?: number
  /** Su lista de tareas, si escribió una. */
  plan: PasoPlan[]
  enCurso: Accion[]
  recientes: Accion[]
  totalAcciones: number
  /** Tokens usados en todos sus pedidos al modelo. */
  tokens: number
  /** Primera línea de la respuesta final. */
  resumen?: string
  /** La respuesta final, de donde sale el resumen corto. */
  respuesta?: string
  /** La respuesta resumida en una frase simple por un modelo chico. */
  resumenCorto?: string
  /** Falta pedir el resumen corto. */
  resumenPendiente?: boolean
  /** Lo movió "Limpiar terminados" al historial. */
  archivado?: boolean
}

/** Qué agentes muestra el panel. */
export type Filtro = 'todos' | 'en-curso' | 'terminados' | 'historial'

declare module 'claude-code' {
  interface PluginState {
    'mapa-agentes': {
      agentes: Shaped<Agente[]>
      reloj: number
      filtro: Filtro
    }
  }
}
