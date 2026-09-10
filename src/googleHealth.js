import "dotenv/config";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://health.googleapis.com/v4";

let cachedAccessToken = null;
let cachedExpiresAt = 0; // epoch ms

/**
 * Intercambia el refresh_token guardado por un access_token vigente.
 * Cachea en memoria y solo pide uno nuevo cuando falta <60s para expirar.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Faltan credenciales de Google en el .env. Corre `npm run auth` primero para generar GOOGLE_REFRESH_TOKEN."
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`No se pudo refrescar el token de Google (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

/**
 * Llama al endpoint `list` o `reconcile` de un dataType con un filtro opcional.
 * dataType va en kebab-case (ej. "daily-heart-rate-variability").
 * Google Health pagina; esta función sigue nextPageToken hasta maxPages.
 */
async function listDataPoints({
  dataType,
  filter,
  useReconcile = false,
  dataSourceFamily,
  maxPages = 3,
}) {
  const accessToken = await getAccessToken();
  const op = useReconcile ? ":reconcile" : "";
  const allPoints = [];
  let pageToken;
  let pages = 0;

  do {
    const params = new URLSearchParams();
    if (filter) params.set("filter", filter);
    if (dataSourceFamily) params.set("dataSourceFamily", dataSourceFamily);
    if (pageToken) params.set("pageToken", pageToken);

    const url = `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints${op}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google Health API error (${res.status}) en ${dataType}: ${body}`);
    }

    const data = await res.json();
    allPoints.push(...(data.dataPoints || []));
    pageToken = data.nextPageToken || undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);

  return allPoints;
}

/** Construye un filtro `civil_start_time >= "YYYY-MM-DDT00:00:00"` para N días atrás. */
function daysBackFilter(dataTypeSnakeCase, daysBack, timeField = "civil_start_time") {
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const iso = from.toISOString().slice(0, 19); // sin milisegundos/Z
  return `${dataTypeSnakeCase}.interval.${timeField} >= "${iso}"`;
}

export { getAccessToken, listDataPoints, daysBackFilter, API_BASE };
