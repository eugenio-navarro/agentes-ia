# Filosofía de desarrollo

Guía central para construir software: la sigo yo y la sigue todo el equipo de agentes (architect, engineer
y tester) en cualquier proyecto. Si el `CLAUDE.md` de un proyecto define algo distinto, manda el del
proyecto (ver [Ajustes por proyecto](#ajustes-por-proyecto)).

## La idea central

Programar no es escribir instrucciones. El camino es **problema → modelo → diseño → lenguaje**, en ese orden.

El objetivo es software que **funcione hoy, se siga entendiendo mañana y otros puedan leer, testear y
cambiar**, y que además **aguante el uso real**: datos que no se pierden ni se corrompen, reglas que no se
pueden saltear, seguridad desde el principio y un sistema que se puede operar durante años.

Las tablas y los formularios son la parte fácil. La diferencia está en lo que no se ve: el modelo, las
reglas, los datos, la seguridad y la operación.

## Principios

1. **Entender antes de construir.** Primero el problema real, el usuario y el valor que recibe. Se releva
   con los usuarios y mirándolos trabajar, no imaginando.
2. **Modelar antes de programar.** Qué conceptos existen, quién es responsable de qué, qué transiciones de
   estado son válidas y qué invariantes se cumplen siempre.
3. **Atacar la complejidad accidental, no la esencial.** La complejidad del problema no se elimina; la que
   agregamos nosotros sí: estado global, reglas duplicadas, `null` sin tratar, infraestructura mezclada con
   lógica de negocio, pasos cuyo orden solo conoce el autor.
4. **Decidir según el costo de revertir.** Lo caro de cambiar después (modelo de datos, base de datos,
   arquitectura, seguridad, plataforma) se decide desde el primer día pensando en producción. Lo barato se
   resuelve de la forma más simple y se ajusta cuando haga falta.
5. **Se recorta alcance, nunca calidad.** Un MVP tiene menos funciones, no peores decisiones. Las
   "adaptaciones para la demo" son deuda técnica a propósito.
6. **Simple, no simplista.** La solución más simple que aguanta el uso real a la escala real. Ni atajos que
   se rompen ni sobreingeniería "por si acaso" (YAGNI): la sobreingeniería también es mediocridad, porque
   agrega piezas que mantener y que se pueden romper.
7. **Los datos viven más que el código.** El código se reescribe; años de datos mal guardados, no. Se
   cuidan los datos más que cualquier otra cosa.
8. **Legible antes que corto.** El código se lee mucho más de lo que se escribe: nombres del dominio,
   funciones chicas, una responsabilidad por unidad.
9. **Incremental.** Pasos chicos, cada uno funcionando, probado y commiteado: un cambio, un diff, un commit.
   Nunca dejar el proyecto roto entre tareas.
10. **Evidencia antes que afirmaciones.** Nada está "listo" sin una prueba, un comando o una salida que lo
    demuestre. Lo no validado se dice explícitamente.
11. **Seguro por defecto.** La seguridad es parte del diseño desde el principio, no una etapa final.

## Del problema al alcance

- Todo proyecto arranca con: **nombre**, **problema, usuario y valor** (un párrafo) y **alcance dentro /
  fuera** explícito.
- Un **MVP** es la versión más simple que resuelve el problema central y entrega valor real: mínimo,
  usable, acotado y bien hecho. No es "lo que alcance a codear" ni una demo decorativa.
- El recorte es parte del diseño: mejor un flujo central completo que un poco de todo. Se elige el flujo
  que el usuario usa a diario, del que dependen los demás y donde hoy sufre.
- Cada compromiso del alcance se cumple entero. Un extra no compensa un compromiso incumplido.

## Diseño

### Modelo y reglas
- **Las reglas viven cerca de los datos que usan**, en el modelo del dominio, y se escriben **una sola
  vez** (cada umbral, conversión o cálculo).
- **Estado explícito.** Las transiciones válidas (por ejemplo `BORRADOR → CONFIRMADO → ENVIADO`) están
  protegidas por reglas que preservan los invariantes. Los estados inválidos no se pueden representar.
- **Derivar en vez de guardar suelto.** Lo que se puede calcular a partir de hechos registrados se calcula
  (el stock sale de los movimientos, no de un número editable a mano). Así la historia siempre se puede
  reconstruir.
- **Tipos que expresan el dominio.** Un valor que puede faltar es `T?`, no `0` ni `""`. Los estados son
  tipos cerrados (enums o clases selladas). Los conceptos importantes tienen su propio tipo, no un
  `String` o un `Double` genérico.
- **Dinero:** nunca con punto flotante; decimal exacto o enteros en la unidad mínima, y **la moneda es parte
  del valor**.
- **Fechas y horas:** siempre con zona horaria.

### Paradigmas, usados con intención
- **Inmutabilidad por defecto** (`val`, copias en vez de modificaciones).
- **Funcional para transformar datos** (`map`, `filter`, `sum`) en lugar de bucles con variables mutables,
  cuando hace al código más claro.
- **Efectos en los bordes.** Una función que calcula no imprime, no escribe archivos ni habla con la base.
- Las `data class` y similares reducen ceremonia, pero no reemplazan al modelado.

### Arquitectura
- **Capas con dependencias hacia adentro:** interfaz → casos de uso → modelo. La persistencia y las
  integraciones se conectan detrás de interfaces.
  - El **modelo** no conoce ni la base de datos, ni HTTP, ni las pantallas.
  - Los **casos de uso** coordinan; solo coordinan.
  - La **persistencia** solo guarda y lee.
  - La **interfaz** solo muestra y captura lo que hace el usuario.
- **Las reglas del negocio se verifican en el servidor**, en cada operación. Ocultar un botón en la
  interfaz no es una regla.
- **Una API como única puerta de entrada** a las reglas. La web, una app de celular o una integración son
  clientes de esa misma API; ninguno duplica reglas.
- **Monolito modular por defecto:** un solo sistema, separado por módulos del negocio. Microservicios,
  colas o clústeres solo cuando un problema real y medido los justifique.
- **Web primero** para sistemas de gestión: una sola instalación, cualquier dispositivo, un solo lugar que
  proteger. Escritorio o celular nativo solo ante una necesidad concreta (sin conexión, hardware, cámara).

### Datos
- **Base relacional por defecto** para datos de negocio, y **PostgreSQL** como primera opción.
- **Transacciones** para toda operación que modifica más de una cosa: se hace completa o no se hace.
- **La base es la segunda red de seguridad:** las reglas críticas también se refuerzan con restricciones
  (`UNIQUE`, `NOT NULL`, `CHECK`, claves foráneas).
- **Migraciones versionadas** para todo cambio de estructura. Nunca se modifica una base de producción a
  mano.

### Herramientas
- Preferir la librería estándar y herramientas **maduras, estándar y con comunidad grande** antes que
  novedades o dependencias nuevas. Versiones estables actuales, verificadas en la documentación oficial.
- No atarse a proveedores cerrados para lo que es central al negocio.

## Calidad y testing

- **TDD:** los tests se escriben primero y funcionan como especificación. Nunca se debilitan, borran ni
  saltean para que pasen.
- **Probar comportamiento observable**, no detalles internos, para poder refactorizar sin romper tests.
- **Pirámide de tests:**
  - **Unitarios** sobre el modelo y las reglas: la mayoría, rápidos, sin infraestructura.
  - **De integración** contra la infraestructura real (por ejemplo, la misma base de datos que producción
    en un contenedor), no contra imitaciones que se comportan distinto.
  - **De punta a punta (E2E)** sobre los flujos completos, a través de la interfaz real.
- **Cobertura proporcional al riesgo:** más pruebas donde un error cuesta más (datos, dinero, permisos,
  seguridad). La cobertura es un indicador, no el objetivo; si el proyecto fija un mínimo, se cumple.
- **Integración continua:** cada push compila y corre todos los tests automáticamente.
- Ningún warning ni error de lint nuevo queda sin resolver.
- **Build reproducible:** el proyecto se construye y corre desde cero siguiendo el README, en cualquier
  máquina.

## Seguridad

- **HTTPS siempre**, también en sistemas internos.
- **Autenticación:** contraseñas guardadas solo como hash con algoritmos lentos (Argon2, bcrypt); segundo
  factor para cuentas con privilegios.
- **Autorización:** roles y permisos verificados en el servidor, en cada operación.
- **Entradas validadas en los bordes** del sistema; **consultas parametrizadas** (nunca SQL armado pegando
  texto); **salida escapada** en las pantallas.
- **Mínimo privilegio:** la base de datos nunca expuesta a internet; cada componente con solo los permisos
  que necesita.
- **Secretos fuera del código y de Git** (variables de entorno o gestores de secretos).
- **Un secreto encontrado no se copia:** se referencia por archivo y línea, nunca se pega completo en
  reportes, comandos, logs ni prompts.
- **Auditoría:** quién hizo qué y cuándo en las operaciones sensibles (dinero, autorizaciones, precios).
- **Dependencias mínimas y actualizadas**, con alertas de vulnerabilidades.
- **Datos personales:** se cumple la normativa aplicable (en Argentina, la Ley 25.326). En repos, tests,
  demos y prompts se usan datos inventados, nunca datos reales de clientes o del negocio.
- **OWASP Top 10** como lista mínima de revisión.

## Producción y operación

- **Entornos separados:** desarrollo, pruebas y producción. En producción no se prueba.
- **Despliegue automatizado y repetible**, con forma de volver a la versión anterior.
- **Copias de seguridad automáticas, fuera del servidor y con restauración probada.** Se definen de antemano
  cuántos datos se pueden perder como máximo y cuánto tiempo puede estar caído el sistema.
- **Logs, monitoreo y alertas:** enterarse de una falla antes que el usuario.
- **Reemplazar sistemas existentes de a poco** (módulo por módulo o en paralelo), nunca apagando el viejo de
  golpe. La migración de datos se planifica.
- **Los repositorios, dominios y cuentas pertenecen a la organización** dueña del sistema, no a una cuenta
  personal.

## Decisiones y documentación

- Las decisiones **grandes o difíciles de revertir** (stack, arquitectura, datos, plataforma, dependencias
  nuevas) las toma el usuario. El equipo propone 2–3 alternativas con sus trade-offs y una recomendación.
- Las decisiones **chicas y reversibles** las toma el equipo y las documenta en `CLAUDE.md`.
- Ante la duda: si la decisión es grande, preguntar; si es chica, elegir lo más simple y reversible.
- Cada decisión de arquitectura queda en un **ADR** (`docs/adr/NNNN-titulo.md`): contexto, decisión,
  alternativas descartadas y consecuencias, con estado (Propuesta, Aceptada, Reemplazada). Un ADR
  aceptado no se edita: se reemplaza por uno nuevo.
- El **diseño vigente** se documenta aparte: responsabilidades, diagrama de cajas y flechas y hallazgos.

## Trabajo con IA

- **La IA asiste; la autoría y la responsabilidad son del ingeniero.** Se declara su uso y no se entrega
  nada que no se entienda y no se pueda explicar y defender línea por línea.
- **Primero planificar, después construir.** Se pide análisis de responsabilidades y 2–3 alternativas, no
  código. Con la decisión tomada, se construye.
- **Pedidos precisos que digan dónde vive cada cosa:** el modelo por un lado, las reglas independientes de
  la interfaz, la persistencia que solo guarda y lee, la interfaz que solo muestra. La IA escribe el código;
  el ingeniero dice cómo modelarlo.
- **Cambios chicos y revisados:** cada diff se lee antes de aceptarlo.
- **Verificar todo** con documentación oficial, ejecución y tests. La IA puede equivocarse con total
  seguridad.
- **Trazabilidad:** cuando el proyecto lo pide, se registra cada prompt y su respuesta, y qué se corrigió y
  por qué.
- **Aprender, no solo producir:** usar la IA para entender qué es cada herramienta, para qué sirve y cómo
  funciona.
- **Separar quién hace y quién verifica:** el architect define y valida, el tester especifica con pruebas y
  verifica de forma independiente, el engineer implementa. Nadie aprueba su propio trabajo.
- **Rol visible al delegar:** la descripción de cada tarea delegada empieza con el rol de quien la hace
  (`ARQ` para el software-architect, `ING` para el software-engineer, `TEST` para el software-tester),
  por ejemplo `ARQ: inicializar el proyecto`, para identificar a cada agente en el mapa de agentes.

## Comunicación

- Idioma de las conversaciones, la documentación y los reportes: español.
- Idioma del código y los commits: lo fija cada proyecto en su `CLAUDE.md`, y se usa uno solo de forma
  consistente. El vocabulario del dominio es el mismo en el código y en las conversaciones con el usuario.
- Reportes breves: qué se hizo, evidencia, decisiones y riesgos. Sin relleno.
- Honestidad ante todo: los errores, bloqueos y dudas se reportan, no se esconden.

## Lo que no hacemos

- Funcionalidades, refactors o "mejoras" que nadie pidió, o cambios fuera del alcance de la tarea.
- Atajos en decisiones estructurales "porque es solo el MVP".
- Reglas de negocio que solo existen en la interfaz.
- Dinero en punto flotante, o `0` para representar "no hay dato".
- Cambios manuales en producción, o pruebas sobre datos reales.
- Datos reales de clientes o del negocio en repositorios, tests, demos o prompts.
- Desactivar controles de seguridad para que algo funcione.
- Ignorar, silenciar o debilitar errores, tests o warnings.
- Publicar (push) o reescribir el historial sin que lo pida el usuario.

## Ajustes por proyecto

Al iniciar un proyecto nuevo, el architect muestra esta filosofía y pregunta si se mantiene o se ajusta.
Los ajustes se escriben en la sección `## Filosofía del proyecto` del `CLAUDE.md` del proyecto y solo
aplican ahí; este archivo no se modifica por un proyecto puntual.
