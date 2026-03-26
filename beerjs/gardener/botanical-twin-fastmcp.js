/**
 * BOTANICAL TWIN — Servidor FastMCP
 * ─────────────────────────────────────────────
 * Stack: FastMCP (Node.js) + MQTT
 *
 * Mismo set de tools que el servidor MCP anterior,
 * con la API minimalista de FastMCP.
 *
 * Instalación:
 *   npm install fastmcp mqtt zod dotenv
 *
 * Uso (stdio — Claude Desktop):
 *   node botanical-twin-fastmcp.js
 *
 * Uso (SSE — browser / HTTP):
 *   MCP_TRANSPORT=sse MCP_PORT=3001 node botanical-twin-fastmcp.js
 *
 * claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "botanical-twin": {
 *       "command": "node",
 *       "args": ["/ruta/absoluta/botanical-twin-fastmcp.js"]
 *     }
 *   }
 * }
 */

import { FastMCP }     from "fastmcp";
import { z }           from "zod";
import mqtt            from "mqtt";
import { config }      from "dotenv";

config(); // carga .env si existe

// ─────────────────────────────────────────────
// CONFIG — desde .env o valores por defecto
// ─────────────────────────────────────────────
const MQTT_BROKER    = process.env.MQTT_BROKER    || "mqtt://localhost:1883";
const MQTT_USER      = process.env.MQTT_USER      || "";
const MQTT_PASS      = process.env.MQTT_PASS      || "";
const MCP_TRANSPORT  = process.env.MCP_TRANSPORT  || "stdio"; // "stdio" | "sse"
const MCP_PORT       = Number(process.env.MCP_PORT || 3001);

// Topics MQTT
const T_SENSORES = "jardin/sensores";
const T_ALERTAS  = "jardin/alertas";
const T_EVENTOS  = "jardin/eventos";
const T_PROX     = "jardin/proximidad";
const T_RIEGO    = "jardin/comandos/riego";
const T_CONFIG   = "jardin/config";

// ─────────────────────────────────────────────
// ESTADO EN MEMORIA
// ─────────────────────────────────────────────
const MAX_H     = 200;
const historial = [];   // lecturas de sensores
const alertas   = [];   // alertas recibidas
const eventos   = [];   // eventos del sistema
const visitas   = [];   // detecciones de proximidad / PIR

let ultimaLectura = null;
let ultimaProx    = null;
let riegosHoy     = 0;

// ─────────────────────────────────────────────
// MQTT
// ─────────────────────────────────────────────
const mqttOpts = { clientId: "botanical-fastmcp", reconnectPeriod: 3000 };
if (MQTT_USER) { mqttOpts.username = MQTT_USER; mqttOpts.password = MQTT_PASS; }

const broker = mqtt.connect(MQTT_BROKER, mqttOpts);

broker.on("connect", () => {
  console.error(`[MQTT] Conectado a ${MQTT_BROKER}`);
  broker.subscribe([T_SENSORES, T_ALERTAS, T_EVENTOS, T_PROX]);
});
broker.on("error",     e  => console.error("[MQTT] Error:", e.message));
broker.on("reconnect", () => console.error("[MQTT] Reconectando..."));

broker.on("message", (topic, raw) => {
  let data;
  try { data = JSON.parse(raw.toString()); } catch { return; }
  const ts = new Date().toISOString();

  if (topic === T_SENSORES) {
    // Normalizar claves: el ESP8266 manda "suelo", el servidor usa "soil"
    ultimaLectura = {
      temp:  data.temp  ?? null,
      hum:   data.hum   ?? null,
      soil:  data.suelo ?? data.soil ?? null,
      dist:  data.dist  ?? data.prox ?? null,
      pir:   data.pir   ?? null,
      ts,
    };
    historial.push(ultimaLectura);
    if (historial.length > MAX_H) historial.shift();
  }

  if (topic === T_ALERTAS) {
    alertas.push({ ...data, ts });
    if (alertas.length > 50) alertas.shift();
    console.error(`[ALERTA] ${data.tipo} = ${data.valor}`);
  }

  if (topic === T_EVENTOS) {
    eventos.push({ ...data, ts });
    if (eventos.length > 50)  eventos.shift();
    if (data.evento === "riego_completado") riegosHoy++;
    if (data.evento === "persona_detectada") {
      visitas.push({ ts, dist: data.distancia ?? null });
      if (visitas.length > 100) visitas.shift();
    }
    console.error(`[EVENTO] ${data.evento}`);
  }

  if (topic === T_PROX) {
    ultimaProx = { ...data, ts };
    if (data.cerca) {
      visitas.push({ ts, dist: data.distancia_cm ?? null, fuente: "proximidad" });
      if (visitas.length > 100) visitas.shift();
    }
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function pub(topic, payload) {
  return new Promise((res, rej) =>
    broker.publish(topic, JSON.stringify(payload), { qos: 1 }, e => e ? rej(e) : res())
  );
}

function calcResumen(n = 20) {
  const d = historial.slice(-n);
  if (!d.length) return null;
  const temps  = d.map(x => x.temp).filter(v => v != null);
  const suelos = d.map(x => x.soil).filter(v => v != null);
  const avg    = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    lecturas:    d.length,
    temp_max:    temps.length  ? Math.max(...temps).toFixed(1)   : null,
    temp_min:    temps.length  ? Math.min(...temps).toFixed(1)   : null,
    temp_prom:   temps.length  ? avg(temps).toFixed(1)           : null,
    suelo_prom:  suelos.length ? Math.round(avg(suelos))         : null,
    suelo_min:   suelos.length ? Math.min(...suelos)             : null,
    riegos_hoy:  riegosHoy,
    visitas_hoy: visitas.length,
    alertas_rec: alertas.slice(-5),
  };
}

function estadoSuelo(pct) {
  if (pct == null) return "sin dato";
  if (pct < 20)   return "CRÍTICO — riego urgente";
  if (pct < 35)   return "Bajo — considerar riego";
  if (pct > 80)   return "Saturado — no regar";
  return "Óptimo";
}

function estadoTemp(t) {
  if (t == null) return "sin dato";
  if (t > 35)    return "CALOR EXCESIVO — riesgo de estrés";
  if (t < 10)    return "FRÍO EXCESIVO — proteger planta";
  return "Normal";
}

// ─────────────────────────────────────────────
// FASTMCP SERVER
// ─────────────────────────────────────────────
const mcp = new FastMCP({
  name:    "botanical-twin",
  version: "2.0.0",
});

// ── Tool: leer_sensores ──
mcp.addTool({
  name:        "leer_sensores",
  description: "Lee en tiempo real temperatura, humedad del aire, humedad del suelo, distancia HC-SR04 y estado PIR desde el ESP8266 via MQTT.",
  parameters:  z.object({}),
  execute: async () => {
    if (!ultimaLectura) {
      return "Sin datos todavía. El ESP8266 publica cada 10 segundos. Verificá WiFi y broker MQTT.";
    }
    const { temp, hum, soil, dist, pir, ts } = ultimaLectura;
    return JSON.stringify({
      temperatura:    temp != null ? `${temp}°C` : "sin dato",
      estado_temp:    estadoTemp(temp),
      humedad_aire:   hum  != null ? `${hum}%`   : "sin dato",
      humedad_suelo:  soil != null ? `${soil}%`   : "sin dato",
      estado_suelo:   estadoSuelo(soil),
      movimiento_pir: pir  ? "DETECTADO" : "Sin movimiento",
      distancia:      dist != null ? `${dist} cm` : "N/D",
      riegos_hoy:     riegosHoy,
      ultima_lectura: ts,
    }, null, 2);
  },
});

// ── Tool: historial_sensores ──
mcp.addTool({
  name:        "historial_sensores",
  description: "Devuelve historial de lecturas. Permite analizar si la planta tuvo calor, frío o falta de agua.",
  parameters:  z.object({
    ultimas_n: z.number().optional().describe("Cantidad de lecturas a devolver (máx 200). Default: 20."),
    formato:   z.enum(["resumen", "completo"]).optional().describe("resumen = estadísticas agregadas. completo = array. Default: resumen."),
  }),
  execute: async ({ ultimas_n, formato }) => {
    const n = Math.min(ultimas_n ?? 20, MAX_H);
    if (formato === "completo") {
      const d = historial.slice(-n);
      return JSON.stringify(d.length ? d : "Sin historial todavía.", null, 2);
    }
    const r = calcResumen(n);
    return JSON.stringify(r ?? "Sin historial todavía.", null, 2);
  },
});

// ── Tool: regar_planta ──
mcp.addTool({
  name:        "regar_planta",
  description: "Activa la bomba de agua enviando un comando MQTT al ESP8266. Usalo cuando el suelo esté seco o cuando el usuario lo pida explícitamente.",
  parameters:  z.object({
    segundos: z.number().min(1).max(30).describe("Duración del riego en segundos (1-30). Recomendado: 5-15."),
    motivo:   z.string().optional().describe("Razón del riego para el log. Ej: 'suelo al 18%'."),
  }),
  execute: async ({ segundos, motivo }) => {
    if (!broker.connected) {
      return "Error: sin conexión MQTT. No se pudo enviar el comando de riego.";
    }
    const seg = Math.min(Math.max(Math.round(segundos), 1), 30);
    await pub(T_RIEGO, {
      segundos: seg,
      motivo:   motivo ?? "agente_fastmcp",
      ts:       new Date().toISOString(),
    });
    console.error(`[RIEGO] Comando enviado: ${seg}s`);
    return JSON.stringify({
      estado:   "comando_enviado",
      segundos: seg,
      topic:    T_RIEGO,
      mensaje:  `Bomba activada por ${seg} segundos. El ESP8266 confirmará con 'riego_completado'.`,
    }, null, 2);
  },
});

// ── Tool: estado_proximidad ──
mcp.addTool({
  name:        "estado_proximidad",
  description: "Devuelve estado actual del HC-SR04: distancia, si hay alguien cerca, y registro de visitas del día.",
  parameters:  z.object({}),
  execute: async () => {
    return JSON.stringify({
      lectura_actual:    ultimaProx  ?? "sin datos",
      visitas_hoy:       visitas.length,
      ultima_visita:     visitas.slice(-1)[0] ?? null,
      historial_visitas: visitas.slice(-10),
    }, null, 2);
  },
});

// ── Tool: resumen_dia ──
mcp.addTool({
  name:        "resumen_dia",
  description: "Resumen completo del día: temperatura máx/mín, humedad, riegos realizados, visitas detectadas, alertas.",
  parameters:  z.object({}),
  execute: async () => {
    const r = calcResumen(MAX_H);
    if (!r) return "Sin datos suficientes para el resumen del día.";
    return JSON.stringify({
      ...r,
      visitas_hoy:  visitas.length,
      ultima_visita: visitas.slice(-1)[0] ?? null,
      alertas_hoy:  alertas.length,
      eventos_hoy:  eventos.slice(-5),
    }, null, 2);
  },
});

// ── Tool: alertas_recientes ──
mcp.addTool({
  name:        "alertas_recientes",
  description: "Devuelve las últimas alertas enviadas por el ESP8266 (calor, frío, suelo seco).",
  parameters:  z.object({
    cantidad: z.number().optional().describe("Cuántas alertas devolver. Default: 10."),
  }),
  execute: async ({ cantidad }) => {
    const d = alertas.slice(-(cantidad ?? 10));
    return JSON.stringify(d.length ? d : "Sin alertas registradas en esta sesión.", null, 2);
  },
});

// ── Tool: configurar_umbrales ──
mcp.addTool({
  name:        "configurar_umbrales",
  description: "Envía nuevos umbrales de operación al ESP8266 via MQTT sin necesidad de recompilar el firmware.",
  parameters:  z.object({
    umbral_suelo_seco: z.number().optional().describe("% mínimo de humedad de suelo antes de alerta. Default: 25."),
    umbral_prox_cm:    z.number().optional().describe("Distancia en cm para considerar 'persona cerca'. Default: 60."),
  }),
  execute: async ({ umbral_suelo_seco, umbral_prox_cm }) => {
    const cfg = {};
    if (umbral_suelo_seco != null) cfg.umbral_riego = umbral_suelo_seco;
    if (umbral_prox_cm    != null) cfg.umbral_prox  = umbral_prox_cm;
    if (!Object.keys(cfg).length) {
      return "No se especificó ningún umbral. Pasá umbral_suelo_seco y/o umbral_prox_cm.";
    }
    if (!broker.connected) {
      return "Sin conexión MQTT. No se pudo enviar la configuración.";
    }
    await pub(T_CONFIG, cfg);
    return JSON.stringify({ estado: "configuracion_enviada", config: cfg }, null, 2);
  },
});

// ─────────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────────
if (MCP_TRANSPORT === "sse") {
  // Modo HTTP/SSE — útil para integraciones web o testing con curl
  mcp.start({ transportType: "sse", sse: { port: MCP_PORT } });
  console.error(`[FastMCP] Modo SSE en http://localhost:${MCP_PORT}/sse`);
} else {
  // Modo stdio — para Claude Desktop
  mcp.start({ transportType: "stdio" });
  console.error("[FastMCP] Botanical Twin server iniciado (stdio).");
}