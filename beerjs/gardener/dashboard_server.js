import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.join(process.cwd(), ".env") });

const PORT = Number(process.env.DASHBOARD_PORT || 8080);
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const ROOT_DIR = process.cwd();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || process.env.ANTHROPIC_MODEL || "anthropic/claude-haiku-4.5";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      throw new Error("Body demasiado grande");
    }
  }
  return body;
}

function safePathname(urlPathname) {
  const decoded = decodeURIComponent(urlPathname || "/");
  const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, "");
  return normalized;
}

async function serveStatic(req, res, pathname) {
  let requested = pathname === "/" ? "/gardener.html" : pathname;
  requested = safePathname(requested);

  const abs = path.join(ROOT_DIR, requested);
  if (!abs.startsWith(ROOT_DIR)) {
    sendJson(res, 403, { error: "Ruta no permitida" });
    return;
  }

  let filePath = abs;
  if (existsSync(filePath) && (await fs.stat(filePath)).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: "Archivo no encontrado" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(content);
}

async function handleOpenRouter(req, res) {
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: { message: "OPENROUTER_API_KEY no configurada en .env" } });
    return;
  }

  try {
    const raw = await readBody(req);
    const incoming = JSON.parse(raw || "{}");
    const messages = Array.isArray(incoming.messages) ? [...incoming.messages] : [];
    if (incoming.system) {
      messages.unshift({ role: "system", content: String(incoming.system) });
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`
    };

    if (OPENROUTER_SITE_URL) headers["HTTP-Referer"] = OPENROUTER_SITE_URL;
    if (OPENROUTER_APP_NAME) headers["X-OpenRouter-Title"] = OPENROUTER_APP_NAME;

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: incoming.model || OPENROUTER_MODEL,
        max_tokens: incoming.max_tokens || 1000,
        messages
      })
    });

    const data = await upstream.json();
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: { message } });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, hasOpenRouterKey: Boolean(OPENROUTER_API_KEY) });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/openrouter" || url.pathname === "/api/anthropic")) {
    await handleOpenRouter(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res, url.pathname);
    return;
  }

  sendJson(res, 405, { error: "Metodo no permitido" });
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT}/gardener.html`);
  console.log("[dashboard] API proxy en /api/openrouter");
});
