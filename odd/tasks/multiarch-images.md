# Feature: multiarch-images

Las dos imágenes del producto se construyen y publican para `linux/amd64` y
`linux/arm64`, en un solo tag multi-arquitectura. El operador hace
`docker compose up -d` y Docker elige la que corresponde a su máquina.

Status: in progress
Branch: `main`
Created: 2026-10-29

## Por qué

Hasta ahora la única forma de tener el stack era construir en la máquina destino.
Eso obliga a tener el código, Node y 300 MB de dependencias ahí, y hace que un
servidor arm64 no pueda recibir un artefacto ya probado. Con imágenes publicadas,
"subir a prod" deja de ser "construir allá" y pasa a ser "bajar lo que ya se probó
acá".

## Lo medido antes de decidir (2026-10-29)

Ninguna de estas cosas se asumió; todas se corrieron en esta máquina.

| Pregunta | Resultado |
|---|---|
| ¿El server construye en arm64? | Sí: `buildx --platform linux/arm64` terminó OK |
| ¿Corre nativo en arm64? | Sí: `process.arch` = `arm64`, `loadConfig()` y `createAuthenticator()` OK bajo qemu |
| ¿El web construye en arm64? | Sí: esbuild y rollup resuelven binarios por plataforma, `vite build` OK |
| ¿nginx arm64 sirve el bundle? | Sí: `HTTP 200` con el `index-*.js` correcto |
| ¿Hay bindings nativos propios? | No: **cero** archivos `.node` mapeados en runtime (`/proc/self/maps`) |
| ¿Las imágenes base son multi-arch? | Sí: `node:22.23.2-alpine`, `nginx:1.27-alpine`, `postgres:16-alpine` tienen amd64 y arm64 |
| ¿`--load` multi-arch funciona acá? | Sí, con Docker 29 + store de containerd: cargué amd64+arm64 en una tag y `--platform linux/arm64` eligió bien |
| ¿El contexto de build está limpio? | Sí: `.dockerignore` ya excluye `node_modules`; el contexto real son ~328 KB |

El detalle de `--load` no es anecdótico: **en un Docker anterior al store de
containerd, `--load` de un multi-arch falla** con "cannot load multi-platform
image". Por eso el compose de prod consume imágenes por `image:` y no por `build:`,
y por eso existe `PUSH=1`: con registry el problema no aparece.

## Decisiones

| # | Decisión | Motivo |
|---|---|---|
| M1 | Un tag multi-arquitectura por servicio, no tags por arquitectura | El operador no tiene que saber qué CPU tiene. Es lo que se eligió y lo que la medición respalda. |
| M2 | `docker-compose.prod.yml` separado, con `image:` y sin `build:` | El compose de desarrollo sigue construyendo desde el código. Prod no sabe compilar: consume artefactos. |
| M3 | `REGISTRY` obligatorio, sin valor por defecto inventado | Un namespace adivinado publica imágenes en la cuenta de otro. El script falla y dice qué falta. |
| M4 | `PUSH=1` opcional: sin él, las imágenes quedan locales | Permite probar el build multi-arch antes de tener registry, y deja el camino sin registry disponible. |
| M5 | La versión es un argumento obligatorio, y `latest` se mueve junto a ella | Un despliegue tiene que poder nombrar exactamente qué corría. `latest` es comodidad, no referencia. |
| M6 | `BUILDER` configurable con default `multibuilder` | El builder de `docker-container` es el que soporta multi-arch en todos los casos; el driver `docker` no. |
| M7 | `container_name` se mantiene en prod | Los scripts (`up.sh`, `smoke.mjs`) y la documentación dependen de esos nombres. Cambiarlos rompe más de lo que arregla. |
| M8 | No se toca el compose de desarrollo | Dev sigue con `build:`. Meter `image:` ahí haría que un `up` local baje de un registry ajeno. |

## Non-goals

- CI que publique solo en cada push. No hay remoto Git todavía; el script es el
  camino manual y honesto.
- `docker save`/`load` como flujo documentado. Se menciona como alternativa, pero
  con registry elegido no es el camino principal.
- Reducir el tamaño de la imagen del server (~429 MB). Se midió que los prebuilds
  nativos de `pi-tui` **no se cargan** en runtime, así que hay margen, pero recortar
  dependencias de un SDK fijado en `1.4.0` es otro cambio y merece su propia
  medición.
- Fijar digest de las imágenes base por arquitectura. Se usa la tag, como hoy.

## Tasks

- [ ] T1. Este documento.
- [x] T2. `scripts/build.sh`: versión obligatoria, `buildx`, multi-arch, `PUSH` opcional.
- [x] T3. `.dockerignore` de cada servicio: nada de tests ni de estado local en la imagen.
- [x] T4. `docker-compose.prod.yml`: `image:` por servicio, sin `build:`.
- [x] T5. README: cómo se publica y cómo se consume.
- [x] T6. Verificar: build multi-arch real, arranque de las dos arquitecturas, smoke.

## Commits

| Commit | Contenido |
|---|---|
| `TBD` | `feat(build)`: script multi-arch + compose de prod |
| `TBD` | `docs`: publicación y consumo, con lo medido |

## Evidence log

| Fecha | Task | Evidencia |
|---|---|---|
| 2026-10-29 | T1 | Las ocho mediciones de la tabla de arriba, corridas en esta máquina antes de escribir una línea. |
| 2026-10-29 | T2 | Guardas probadas: sin versión imprime uso y sale 1; `"1.0; rm -rf /"` es rechazada por el patrón; `PUSH=1` sin `REGISTRY` nombra lo que falta. |
| 2026-10-29 | T4 | `docker compose config --format json` resuelto: `source: build=no` en los tres servicios; en dev, 2 `build:` activos. |
| 2026-10-29 | T4 | Un bug encontrado y corregido: el compose exigía `REGISTRY` con `:?`, pero `build.sh` sin registry taggea `agentdocumentor-server:0.1.0` **sin prefijo**. No se podían consumir. Ahora usa `${REGISTRY:+${REGISTRY}/}`, que prefija sólo cuando hay valor. |
| 2026-10-29 | T6 | Build real: `./scripts/build.sh 0.1.0` produjo índices OCI (`application/vnd.oci.image.index.v1+json`) para server y web. |
| 2026-10-29 | T6 | Mismo tag, dos arquitecturas: `docker run --platform linux/amd64` → `x64 OK`; `--platform linux/arm64` → `arm64 OK`. Web en ambas: `HTTP 200` con el mismo bundle. |
| 2026-10-29 | T6 | Stack de prod levantado **desde las imágenes, sin construir**: los 3 healthy, images `postgres:16-alpine`, `agentdocumentor-server:0.1.0`, `agentdocumentor-web:0.1.0`. |
| 2026-10-29 | T6 | `smoke.mjs` contra ese stack: 7/7 + 1 SKIP. |
| 2026-10-29 | T6 | Suite completa: server 190/190 (0 skip), web 175/175, `tsc` exit 0 en ambos. |

## Nota de operación encontrada durante la verificación

Levantar el compose de prod sobre el volumen de Postgres existente falla con
`password authentication failed`, porque `POSTGRES_PASSWORD` **sólo aplica en el
primer `initdb`**. El volumen que está en esta máquina se inicializó con el default
`agentdocumentor`. En un despliegue nuevo no aparece; en uno que reusa un volumen
viejo, sí — y la solución es `ALTER USER` o un volumen nuevo, no tocar el compose.
