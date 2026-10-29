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
- [ ] T2. `auth.ts`: modo `open` + `mode` explícito. `main.ts`: `AUTH_MODE` y warns.
- [ ] T3. `credentials.ts`: `user` obligatorio, `token` opcional. `App.tsx`: copy sin token.
- [ ] T4. `docker-compose.yml`, `up.sh`, `dev-env.sh`, `smoke.mjs`, `provision-mcp.mjs`.
- [ ] T5. `users.test.ts`: tests del modo abierto.
- [ ] T6. README: decir que no hay cuentas.
- [ ] T7. Verificar: server tests, vitest, tsc, curls, smoke.

## Evidence log

| Fecha | Task | Evidencia |
|---|---|---|
| 2026-10-29 | T1 | Medido antes de tocar: `isolation.test.ts:116` construye el authenticator con `{ devToken }` y `headers()` manda un par coincidente, así que los 7 tests no dependen del roster. `http-api.test.ts:65` igual. `smoke.mjs:132` es el único que asume un secreto. |
