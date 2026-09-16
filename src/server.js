import "dotenv/config";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { listDataPoints, daysBackFilter } from "./googleHealth.js";

const DEFAULT_FAMILY =
  process.env.DEFAULT_DATA_SOURCE_FAMILY || "users/me/dataSourceFamilies/google-wearables";

// ---------- Helpers para dar forma a las respuestas de sueño ----------

function summarizeSleepSession(dp) {
  const s = dp.sleep;
  if (!s) return null;
  const summary = s.summary || {};
  const stages = Object.fromEntries(
    (summary.stagesSummary || []).map((st) => [st.type.toLowerCase(), Number(st.minutes)])
  );
  const minutesAsleep = Number(summary.minutesAsleep || 0);
  const minutesInBed = Number(summary.minutesInSleepPeriod || 0);
  const efficiency = minutesInBed > 0 ? Math.round((minutesAsleep / minutesInBed) * 100) : null;

  return {
    start: s.interval?.startTime,
    end: s.interval?.endTime,
    device: dp.dataSource?.device?.displayName || dp.dataSource?.platform || "desconocido",
    minutesInBed,
    minutesAsleep,
    minutesAwake: Number(summary.minutesAwake || 0),
    minutesToFallAsleep: Number(summary.minutesToFallAsleep || 0),
    minutesAfterWakeUp: Number(summary.minutesAfterWakeUp || 0),
    sleepEfficiencyPercent: efficiency,
    stagesMinutes: stages, // { light, deep, rem, awake }
  };
}

async function fetchSleepSessions(daysBack) {
  const filter = daysBackFilter("sleep", daysBack, { recordType: "interval", field: "civil_end_time" });
  const points = await listDataPoints({
    dataType: "sleep",
    filter,
    useReconcile: true,
    dataSourceFamily: DEFAULT_FAMILY,
  });
  return points.map(summarizeSleepSession).filter(Boolean);
}

function average(nums) {
  const valid = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!valid.length) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}

// ---------- MCP server ----------

function buildMcpServer() {
  const server = new McpServer({ name: "fitbit-health", version: "1.0.0" });

  server.tool(
    "get_sleep_sessions",
    "Devuelve las sesiones de sueño individuales (una por noche/siesta) de los últimos N días, con etapas (light/deep/rem/awake), eficiencia y tiempos de dormir/despertar. Fuente: Google Health API (datos originados en Fitbit).",
    { days_back: z.number().int().min(1).max(60).default(7) },
    async ({ days_back }) => {
      const sessions = await fetchSleepSessions(days_back);
      return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
    }
  );

  server.tool(
    "get_sleep_summary",
    "Devuelve un resumen agregado de sueño de los últimos N días: promedios de tiempo dormido, eficiencia, minutos en cada etapa, y cuántas noches hay con datos. Útil para responder '¿cómo he dormido esta semana?'.",
    { days_back: z.number().int().min(1).max(60).default(7) },
    async ({ days_back }) => {
      const sessions = await fetchSleepSessions(days_back);
      const summary = {
        periodDays: days_back,
        nightsWithData: sessions.length,
        avgMinutesAsleep: average(sessions.map((s) => s.minutesAsleep)),
        avgMinutesInBed: average(sessions.map((s) => s.minutesInBed)),
        avgSleepEfficiencyPercent: average(sessions.map((s) => s.sleepEfficiencyPercent)),
        avgMinutesToFallAsleep: average(sessions.map((s) => s.minutesToFallAsleep)),
        avgStageMinutes: {
          light: average(sessions.map((s) => s.stagesMinutes.light)),
          deep: average(sessions.map((s) => s.stagesMinutes.deep)),
          rem: average(sessions.map((s) => s.stagesMinutes.rem)),
          awake: average(sessions.map((s) => s.stagesMinutes.awake)),
        },
        sessions,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "get_recovery_vitals",
    "Devuelve métricas de recuperación fisiológica de los últimos N días: HRV diario, SpO2 diario, frecuencia respiratoria diaria y frecuencia cardíaca en reposo diaria. Combínalo con get_sleep_summary para evaluar calidad de descanso.",
    { days_back: z.number().int().min(1).max(60).default(7) },
    async ({ days_back }) => {
      const results = {};
      // Los 4 son dataTypes tipo "Daily" en Google Health API: se filtran por fecha (.date), no por interval/sample.
      const dataTypes = [
        { key: "hrv", dataType: "daily-heart-rate-variability", snake: "daily_heart_rate_variability" },
        { key: "spo2", dataType: "daily-oxygen-saturation", snake: "daily_oxygen_saturation" },
        { key: "respiratoryRate", dataType: "daily-respiratory-rate", snake: "daily_respiratory_rate" },
        {
          key: "restingHeartRate",
          dataType: "daily-resting-heart-rate",
          snake: "daily_resting_heart_rate",
        },
      ];

      for (const dt of dataTypes) {
        try {
          const filter = daysBackFilter(dt.snake, days_back, { recordType: "daily" });
          const points = await listDataPoints({ dataType: dt.dataType, filter, useReconcile: true });
          results[dt.key] = points;
        } catch (err) {
          // Si un data type no aplica a tu dispositivo, no tumbamos toda la respuesta.
          results[dt.key] = { error: err.message };
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "get_heart_rate_raw",
    "Devuelve la serie de frecuencia cardíaca punto por punto (beats per minute, con contexto de movimiento) de los últimos N días. Son datos crudos de alta frecuencia, no un resumen — usa un rango corto (1-3 días) para no traer demasiados puntos.",
    { days_back: z.number().int().min(1).max(7).default(1) },
    async ({ days_back }) => {
      const filter = daysBackFilter("heart_rate", days_back, { recordType: "sample" });
      const points = await listDataPoints({
        dataType: "heart-rate",
        filter,
        useReconcile: true,
        dataSourceFamily: DEFAULT_FAMILY,
        maxPages: 5,
      });
      return { content: [{ type: "text", text: JSON.stringify(points, null, 2) }] };
    }
  );

  server.tool(
    "get_health_data_raw",
    "Escape hatch: consulta cualquier dataType de Google Health API directamente. Usa el nombre del dataType en kebab-case (ej. 'heart-rate', 'body-fat', 'daily-heart-rate-variability'). IMPORTANTE: especifica record_kind según el tipo de dato — 'daily' para métricas con resumen diario (daily-*), 'sample' para mediciones puntuales (heart-rate, weight, oxygen-saturation, body-fat), 'interval' para datos con duración (steps, distance, exercise). Ver https://developers.google.com/health/data-types para el record type de cada dataType.",
    {
      data_type: z.string().describe("dataType en kebab-case, ej. 'heart-rate'"),
      days_back: z.number().int().min(1).max(90).default(7),
      record_kind: z
        .enum(["interval", "sample", "daily"])
        .default("interval")
        .describe("'daily' para daily-*, 'sample' para mediciones puntuales, 'interval' para datos con duración"),
      time_field: z
        .string()
        .optional()
        .describe(
          "Campo de tiempo dentro del record_kind. interval: 'civil_start_time' (default) o 'civil_end_time'. sample: 'civil_time' (default) o 'physical_time'. Ignorado si record_kind es 'daily'."
        ),
      use_reconcile: z.boolean().default(false),
    },
    async ({ data_type, days_back, record_kind, time_field, use_reconcile }) => {
      const snake = data_type.replace(/-/g, "_");
      const filter = daysBackFilter(snake, days_back, { recordType: record_kind, field: time_field });
      const points = await listDataPoints({
        dataType: data_type,
        filter,
        useReconcile: use_reconcile,
        dataSourceFamily: DEFAULT_FAMILY,
      });
      return { content: [{ type: "text", text: JSON.stringify(points, null, 2) }] };
    }
  );

  return server;
}

// ---------- HTTP transport (stateless Streamable HTTP) ----------

const app = express();
app.use(express.json());

// Log de cada request entrante, para diagnosticar conectividad (Render, Claude, etc.)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} — auth header presente: ${Boolean(req.headers["authorization"])}`);
  next();
});

// Auth simple por bearer token estático (independiente del OAuth de Google).
// Este es el secreto que le das a Claude al agregar el custom connector.
app.use("/mcp", (req, res, next) => {
  const expected = process.env.MCP_SHARED_SECRET;
  if (!expected) {
    console.log("AUTH FAIL: MCP_SHARED_SECRET no está configurado en el servidor (env var vacía)");
    return res.status(500).json({ error: "MCP_SHARED_SECRET no configurado en el servidor" });
  }
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== expected) {
    console.log(
      `AUTH FAIL: token recibido (len=${token ? token.length : 0}, últimos 4="${token ? token.slice(-4) : "N/A"}") vs esperado (len=${expected.length}, últimos 4="${expected.slice(-4)}")`
    );
    return res.status(401).json({ error: "unauthorized" });
  }
  console.log("AUTH OK");
  next();
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error manejando request MCP:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Modo stateless: no soportamos GET (server->client streaming) ni DELETE (cierre de sesión).
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`fitbit-health-mcp escuchando en http://localhost:${PORT}/mcp`);
});
