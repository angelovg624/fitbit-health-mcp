# fitbit-health-mcp

Servidor MCP personal que expone tus datos de sueño y recuperación de Fitbit
a Claude, vía la **Google Health API v4** (no la Fitbit Web API legacy, que
se apaga en septiembre 2026).

Tools expuestas:

- `get_sleep_sessions` — sesiones de sueño individuales (etapas, eficiencia)
- `get_sleep_summary` — promedios de los últimos N días
- `get_recovery_vitals` — HRV, SpO2, frecuencia respiratoria, FC en reposo
- `get_health_data_raw` — escape hatch para cualquier otro dataType

## 1. Google Cloud Console

1. Crea un proyecto en https://console.cloud.google.com
2. Habilita **Google Health API** (busca "Health API" en el marketplace de APIs)
3. Configura la pantalla de consentimiento OAuth (External, modo "Testing" está
   bien para uso personal — agrégate a ti mismo como test user)
4. Crea credenciales OAuth 2.0 → tipo **"Web application"**
   - Authorized redirect URI: `http://127.0.0.1:8788/oauth2callback`
5. Copia el Client ID y Client Secret a tu `.env` (ver `.env.example`)

## 2. Instalar y autorizar

```bash
cp .env.example .env
# pega GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en .env
# genera un secreto para Claude:
openssl rand -hex 32   # pega el resultado en MCP_SHARED_SECRET en .env

npm install
npm run auth            # abre el navegador, apruebas el consentimiento de Google
                         # una sola vez -> guarda GOOGLE_REFRESH_TOKEN en .env
```

## 3. Correr el servidor

```bash
npm start
# fitbit-health-mcp escuchando en http://localhost:8787/mcp
```

Pruébalo local:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $MCP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 4. Exponerlo públicamente (HTTPS)

Claude necesita alcanzar tu servidor por HTTPS. Dado tu setup (Mac Mini M4
siempre encendido, ya corriendo Docker/Jellyfin), la opción más consistente
con tu enfoque local-first es un **Cloudflare Tunnel**:

```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
cloudflared tunnel create fitbit-mcp
cloudflared tunnel route dns fitbit-mcp fitbit.tudominio.com
cloudflared tunnel --url http://localhost:8787 run fitbit-mcp
```

Alternativas más simples para probar rápido (sin dominio propio):
`ngrok http 8787` — pero para algo que vas a dejar corriendo, el tunnel de
Cloudflare es gratis y no expone tu IP ni requiere abrir puertos en el router.

## 5. Conectar en Claude

En claude.ai: **Settings → Connectors → Add custom connector**

- **URL**: `https://fitbit.tudominio.com/mcp`
- **Authentication**: elige autenticación por header (`static_headers`, en
  beta) → header `Authorization`, valor `Bearer <tu MCP_SHARED_SECRET>`

Si no ves la opción de header auth en tu versión de la UI, es porque
`static_headers` está en beta — como alternativa, Claude Code sí soporta
headers directamente:

```bash
claude mcp add --transport http fitbit-health https://fitbit.tudominio.com/mcp \
  --header "Authorization: Bearer $MCP_SHARED_SECRET"
```

## Notas y cosas a verificar

- **Nombres de dataType**: confirmé contra la documentación oficial `sleep`,
  `daily-heart-rate-variability`, `daily-oxygen-saturation` y
  `respiratory-rate-sleep-summary`. El de frecuencia cardíaca en reposo
  (`daily-resting-heart-rate`) lo infería por patrón — si `get_recovery_vitals`
  te devuelve un error para esa clave, revisa el nombre exacto en
  https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints
  y ajústalo en `src/server.js`. Mientras tanto, `get_health_data_raw` te
  deja consultar cualquier dataType directo sin tocar código.
- **Paginación**: `sleep` limita a 25 sesiones por página; el cliente sigue
  hasta 3 páginas (75 noches) — de sobra para "esta semana" o "este mes".
- **dataSourceFamily**: por default uso `google-wearables` (solo tu Fitbit,
  sin estimaciones del teléfono). Cámbialo en `.env` si quieres
  `all-sources` o `google-sources`.
- **Scopes**: pedí solo `sleep.readonly` y
  `health_metrics_and_measurements.readonly`. Si más adelante quieres pasos,
  calorías o VO2 max, agrega el scope correspondiente en
  `scripts/setup-oauth.js` y vuelve a correr `npm run auth`.
- **Reautorización**: el token de Google no vence solo mientras uses la app;
  si algún día ves errores de refresh, borra `GOOGLE_REFRESH_TOKEN` del `.env`
  y vuelve a correr `npm run auth`.
