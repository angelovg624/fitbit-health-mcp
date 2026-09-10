/**
 * Flujo de autorización de Google, una sola vez, corrido localmente.
 * Abre el navegador, tú apruebas el consentimiento, y este script
 * guarda el refresh_token en tu .env para que server.js lo use siempre.
 *
 * Uso: npm run auth
 */
import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import open from "open";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en tu .env");
  process.exit(1);
}

const REDIRECT_PORT = 8788;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

// Alcances mínimos para sueño + métricas de recuperación durante el sueño.
// Agrega más de https://developers.google.com/health/scopes si luego quieres
// pasos, calorías, etc.
const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
].join(" ");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline"); // necesario para obtener refresh_token
authUrl.searchParams.set("prompt", "consent"); // fuerza refresh_token también en re-autorizaciones

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Error de OAuth: ${error}`);
    console.error("Error de OAuth:", error);
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok || !data.refresh_token) {
      throw new Error(
        `No se recibió refresh_token: ${JSON.stringify(data)}. ` +
          `Si ya habías autorizado esta app antes, revoca el acceso en https://myaccount.google.com/permissions y vuelve a correr 'npm run auth'.`
      );
    }

    // Guarda/actualiza GOOGLE_REFRESH_TOKEN en .env
    const envPath = new URL("../.env", import.meta.url);
    let envContent = "";
    try {
      envContent = fs.readFileSync(envPath, "utf8");
    } catch {
      envContent = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    }

    if (/^GOOGLE_REFRESH_TOKEN=.*$/m.test(envContent)) {
      envContent = envContent.replace(
        /^GOOGLE_REFRESH_TOKEN=.*$/m,
        `GOOGLE_REFRESH_TOKEN=${data.refresh_token}`
      );
    } else {
      envContent += `\nGOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`;
    }
    fs.writeFileSync(envPath, envContent);

    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end("<h2>Listo ✅</h2><p>Refresh token guardado en .env. Ya puedes cerrar esta pestaña.</p>");

    console.log("\n✅ GOOGLE_REFRESH_TOKEN guardado en .env");
    console.log("Ahora corre: npm start\n");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(err.message));
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log("Abriendo el navegador para autorizar acceso a Google Health API...");
  console.log("Si no se abre solo, visita:\n", authUrl.toString(), "\n");
  open(authUrl.toString());
});
