# Feature: invite-link-auth

El token de la URL es la identidad, y no hay formulario de login. Un enlace
compartido entra directo al producto; un enlace ausente o rechazado dice qué hacer
en vez de pedir dos campos que la persona no tiene.

Status: in progress
Branch: `feature/invite-link-auth`
Created: 2026-10-29

## Por qué

Medido en el stack levantado, con el roster real:

```
curl -H "x-dev-token: $TOK" /api/me        -> 200 {"id":"bob","displayName":"bob"}
curl -H "x-dev-token: $TOK" -H "x-user-id;" -> 401
```

El servidor ya resuelve la identidad con el token solo: `resolveRosterUser`
(`server/src/http/users.ts:83`) acepta `claimedUserId === undefined` y sólo rechaza
un id que **no coincide**. El que exigía el par completo era el cliente:
`credentialsFromUrl` (`web/src/App.tsx:22`) devolvía `null` si faltaba `user`, y el
resultado era el formulario de `AuthGate`.

Peor: ese formulario precargaba el token con el literal `"dev"`
(`AuthGate.tsx:21`), residuo del esquema legacy `DEV_AUTH_TOKEN` que el proyecto ya
reemplazó. En producción eso es una pista falsa: sugiere que hay una contraseña
compartida que adivinar.

Lo que se decidió: **el token se queda en la URL** (es el formato de enlace que ya
se reparte y que el smoke test y los scripts imprimen) y **el formulario
desaparece**. No hay pantalla de credenciales en ninguna rama.

## Non-goals

- Autenticación real: sesión, cookie, JWT, expiración, revocación por dispositivo.
  El roster fijo sigue siendo el modelo, documentado como tal.
- Sacar el token del query string (`#token=` o `sessionStorage`). Se evaluó y se
  descartó para este cambio: cambia el contrato de enlaces que los scripts ya
  imprimen. Queda como feature aparte, con su propia nota de fuga en `access.log`.
- Tocar el servidor. La cabecera `x-user-id` opcional ya funciona.

## Decisiones

| # | Decisión | Motivo |
|---|---|---|
| E1 | La resolución de la URL vive en `web/src/lib/credentials.ts`, no en `App.tsx` | Es lógica pura sobre `location.search`, y `App.tsx` no tiene tests. Un módulo con función pura se testea en ms y sobrevive al próximo rediseño de la pantalla. |
| E2 | `x-user-id` se **omite** cuando la URL no trae `user` | Mandarlo vacío devuelve `401` (medido). Omitirlo hace que el token hable solo, que es justo el camino ya soportado. |
| E3 | Sin token en la URL, la pantalla dice "falta el enlace" y no pide nada | Un formulario sería una promesa falsa: no hay credencial que tipear que no sea ya el token del enlace. |
| E4 | Un token rechazado muestra el mismo aviso, no un formulario | Idem: reintentar tipeando no arregla un token vencido o mal copiado. |
| E5 | El nombre visible sale de `GET /me`, no de la URL | `/me` devuelve `{ id, displayName }` del roster. Es la única fuente que no puede mentir. |
| E6 | `AuthGate.tsx` y su test se eliminan, no se dejan sin usar | Código muerto con un formulario que precarga `"dev"` es exactamente lo que alguien va a reactivar por error. |

## Tasks

- [x] T2. `web/src/lib/credentials.ts` con `parseCredentials`, `authHeaders`, `credentialsUrl` + `credentials.test.ts`.
- [x] T3. `App.tsx` usa el módulo; `MissingInviteLink` reemplaza a `AuthGate`; `auth-gate.test.tsx` y `AuthGate.tsx` eliminados.
- [x] T4. `docker-compose.yml`: `CHAT_USERS` con `:-` en vez de `:?`.
- [x] T5. README: configuración, sección de links, alta de usuarios.
- [x] T6. Verificación: vitest, tsc, `docker compose config`, curls contra el stack.

## Evidence log

| Fecha | Task | Evidencia |
|---|---|---|
| 2026-10-29 | T1 | `vitest run`: 9 files, 165 tests passed. `tsc --noEmit`: exit 0. |
| 2026-10-29 | T2 | `credentials.test.ts`: 9 tests verdes. Antes de implementar el m\u00f3dulo la suite fallaba al importar (`no tests`), que es el rojo esperado. |
| 2026-10-29 | T2/T3 | Mutation check: reintroducir `if (!token \|\| !user) return null` rompe 5 tests; enviar `x-user-id` vac\u00edo rompe 2. C\u00f3digo restaurado, 14/14 verdes. Un test que pasa con el bug presente no prueba nada. |
| 2026-10-29 | T3 | Suite completa: 10 files, 174 tests passed. `tsc --noEmit`: exit 0. `grep AuthGate src/`: sin referencias. |
| 2026-10-29 | T4 | Sin `CHAT_USERS` en el shell: antes `docker compose config`/`ps` fallaban con `required variable`; ahora `config OK` y los 3 contenedores listados. Con la variable exportada, se inyecta igual. |
| 2026-10-29 | T4 | Falla cerrado verificada dentro de la imagen: con roster vac\u00edo, `createAuthenticator` devuelve `undefined` para cualquier token, o sea toda request es 401. |
| 2026-10-29 | T6 | Stack real (imagen web reconstruida): `smoke.mjs` 8/8, incluido "a token cannot claim another user's identity". Bundle servido sin `Sign in` / `Access token` / `Your name`; con los tres textos nuevos. Curls: token solo 200, par correcto 200, `user` ajeno 401, token inv\u00e1lido 401. |

## Commits

| Commit | Contenido |
|---|---|
| `4cd7149` | `docs(odd)`: el plan y su evidencia medida |
| `4cfab0c` | `feat(auth)`: `credentials.ts` + tests |
| `e41d088` | `feat(auth)`: `App` sin formulario, `AuthGate` eliminado, `app.test.tsx` |
| `b553e12` | `fix(compose)`: `CHAT_USERS` deja de ser obligatoria para cada comando |
| `6d59030` | `docs`: `.env`, alta/rotaci\u00f3n de usuarios, links, y la fuga conocida |

## Lo que este cambio NO arregla

El token sigue en el query string, así que nginx lo escribe en `access.log` (formato
`combined`, verificado: `docker logs agentdoc-web` muestra `GET /?user=bob&token=...`).
Moverlo al fragmento (`#token=`) o a `sessionStorage` es una feature aparte, con su
propio cambio de contrato de enlaces.
