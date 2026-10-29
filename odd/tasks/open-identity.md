# Feature: open-identity

La identidad es el nombre que trae el enlace. Sin secreto, sin cuentas, sin
contraseñas. `?user=ana` es ana.

Status: in progress
Branch: `main`
Created: 2026-10-29

## Por qué

Los tokens por usuario resistían la suplantación, y eso los hacía caros de operar:
un secreto por persona, un roster en el entorno, un archivo `.chat-users` que hay
que distribuir por canal privado, y un token que termina en el `access.log` de
nginx porque viaja en el query string.

Decisión del usuario, tomada después de ver la consecuencia: sacar el token y
quedarse con el nombre. Se evaluaron tres caminos (`main` conversación previa) y se
eligió el intermedio: **identidad por nombre, con tokens todavía aceptados si un
cliente los manda**.

## La consecuencia, dicha una sola vez y sin eufemismos

**Esto no es autenticación, y no hay forma de que "valide" sin secreto.**

Un `user` que viene del cliente no se puede validar contra nada: cualquier valor que
pase el formato es aceptado. Entonces:

| Antes (roster) | Ahora (abierto) |
|---|---|
| bob con su token pidiendo `user=alice` → `401` | `?user=alice` → es alice |
| Un extraño con el link de bob lee lo de bob | Un extraño con cualquier link lee lo de cualquiera |
| El sidebar muestra un nombre que el servidor resolvió | El sidebar muestra el nombre que el cliente pidió |

El aislamiento **entre conversaciones** sigue existiendo en la capa de datos: cada
fila tiene su `user_id` y las consultas filtran por él. Lo que desaparece es la
prueba de que quien pide ese `user_id` sea su dueño.

Escribir un `if` que "valide el usuario" sería peor que no tener nada: daría
apariencia de control sin control.

## Non-goals

- Sesión, cookie, JWT, expiración, revocación. Nada de eso entra acá.
- Borrar el modo roster. Queda implementado y probado: el día que haya que
  devolver la resistencia a la suplantación, `AUTH_MODE=roster` y el roster vuelven
  sin reescribir nada.
- Sacar el token del query string. Con el token fuera de la URL, ese problema se
  disuelve; no hay nada que mover al fragmento.

## Decisiones

| # | Decisión | Motivo |
|---|---|---|
| O1 | Tres modos explícitos: `roster`, `shared-token`, `open`, elegidos por `AUTH_MODE` | El código ya tenía dos modos implícitos elegidos por "¿hay roster?". Un tercero sin nombre explícito vuelve la precedencia un acertijo. |
| O2 | `open` es el modo por defecto del compose | Es lo que se decidió operar. El default de producción no debería ser lo que nadie eligió. |
| O3 | El modo `open` valida el FORMATO del id y nada más | Un id vacío o con `/` rompe consultas y logs. Rechazarlo no es seguridad, es higiene: evita filas basura, no suplantación. |
| O4 | `x-dev-token` se sigue enviando si el cliente lo tiene | Permite migrar sin cortar a nadie que ya tenga un link con token, y deja `shared-token` usable sin tocar el cliente. |
| O5 | `isolation.test.ts` NO se skipea | Corre en modo legacy con headers coincidentes y prueba ownership en la capa de datos, que sigue intacto. Apagarlo sería perder cobertura que todavía es verdadera. |
| O6 | El check de suplantación del smoke pasa a `SKIP` con su razón, impreso | La propiedad se cayó por decisión, no por bug. Un test borrado se olvida; un `SKIP` con motivo queda como registro. |
| O7 | `http-api.test.ts` mantiene su test de token equivocado | Ese router se construye con `devToken`, así que la aserción sigue siendo verdadera; se le agrega el caso sin token. |
| O8 | Los scripts dejan de generar `.chat-users` | Un archivo de secretos que ya nadie usa es una trampa para el próximo que lo encuentre. |

## Tasks

- [x] T1. Este documento.
- [x] T2. `auth.ts`: modo `open` + `mode` explícito. `main.ts`: `AUTH_MODE` y warns.
- [x] T3. `credentials.ts`: `user` obligatorio, `token` opcional. `App.tsx`: copy sin token.
- [x] T4. `docker-compose.yml`, `up.sh`, `dev-env.sh`, `smoke.mjs`, `provision-mcp.mjs`.
- [x] T5. `users.test.ts`: tests del modo abierto (17 tests en el archivo).
- [x] T6. README: decir que no hay cuentas.
- [x] T7. Verificar: server tests, vitest, tsc, curls, smoke.

## Evidence log

| Fecha | Task | Evidencia |
|---|---|---|
| 2026-10-29 | T1 | Medido antes de tocar: `isolation.test.ts:116` construye el authenticator con `{ devToken }` y `headers()` manda un par coincidente, así que los 7 tests no dependen del roster. `http-api.test.ts:65` igual. `smoke.mjs` era el único que asumía un secreto. |
| 2026-10-29 | T2 | Un test VIEJO encontró un bug nuevo: con `open` como fallback de la inferencia, "con nada configurado todo se rechaza" fallaba (`alice` era aceptado). Corregido: `resolveAuthMode` devuelve `undefined` sin configuración, y `open` sólo se alcanza pidiéndolo. Test agregado: `inference never falls forward into open mode`. |
| 2026-10-29 | T2 | `parseAuthMode` probado a mano: `"open"`→open, `" roster "`→roster, `""`→undefined, `"opne"`→throw `AUTH_MODE must be one of roster, shared-token, open, got "opne"`. |
| 2026-10-29 | T5 | `users.test.ts`: 17/17. Cubre id solo, sin header, id malformado (`bad id!`, `a/b`, 65 chars), ids válidos reales, precedencia explícita sobre roster y sobre shared-token, y el fail-closed. |
| 2026-10-29 | T7 | Server: 190 tests, 190 pass, 0 fail. Web: 175 tests, 10 files. `tsc --noEmit` exit 0 en ambos. |
| 2026-10-29 | T7 | Stack real reconstruido con `AUTH_MODE=open`: warn en logs (`identity is the claimed x-user-id and there is no secret behind it`). Curls: `x-user-id: alice` → 200; `x-user-id: cualquiera-nuevo` → **200** (la consecuencia aceptada); sin header → 401; `bad id!` → 401; token viejo sin user → 401. |
| 2026-10-29 | T7 | `smoke.mjs`: 7/7 checks + 1 SKIP visible. Los 3 checks de ownership siguen pasando. Bundle servido sin "Access token"/"Sign in"/"personal token". |
| 2026-10-29 | T4 | `provision-mcp.mjs` probado: `USERS="ana,luis,ana"` deduplica; sin nada configurado nombra qué falta (`No users. Set USERS=alice,bob...`). |

## Commits

| Commit | Contenido |
|---|---|
| `a55edd5` | `docs(odd)`: la decisión y lo medido antes de tocar |
| `ad5371d` | `feat(auth)`: modo `open`, `AUTH_MODE` explícito, fail-closed |
| `c4b05f5` | `feat(web)`: identidad por nombre, token opcional |
| `7613b9f` | `chore`: open por defecto, sin rosters, SKIP del smoke |
| `73fc560` | `docs`: decir que no hay autenticación |

## Cómo se vuelve atrás

`AUTH_MODE=roster` + `CHAT_USERS=id:token,...` + `docker compose up -d server`. El
código del roster está intacto y testeado. Lo único que hay que restaurar a mano es
el check de suplantación del smoke, que hoy imprime su propio recordatorio.
