/**
 * BOTANICAL TWIN — Servidor MCP
 * Stack: Node.js + MQTT + @modelcontextprotocol/sdk
 *
 * Conecta el agente Claude con el ESP32 via MQTT.
 * Expone tools para: leer sensores, regar, historial, proximidad.
 *
 * Instalación:
 *   npm install @modelcontextprotocol/sdk mqtt
 *
 * Uso:
 *   node botanical-twin-server.js
 *
 * Registrar en Claude Desktop (~/.config/Claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "botanical-twin": {
 *         "command": "node",
 *         "args": ["/ruta/absoluta/botanical-twin-server.js"]
 *       }
 *     }
 *   }
 */

import { Server }              from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mqtt                    from "mqtt";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const MQTT_BROKER   = "mqtt://localhost:1883";   // cambiá si tu broker está en otra IP
const MQTT_CLIENT_ID = "botanical-twin-mcp";

// Topics entrantes (ESP32 → servidor)
const T_SENSORES    = "jardin/sensores";         // {"temp":22.4,"hum":58,"suelo":45,"prox":120}
const T_ALERTAS     = "jardin/alertas";          // {"tipo":"suelo_seco","valor":18}
const T_EVENTOS     = "jardin/eventos";          // {"evento":"riego_completado","segundos":10}
const T_PROX        = "jardin/proximidad";       // {"distancia_cm":45,"cerca":true}

// Topics salientes (servidor → ESP32)
const T_RIEGO_CMD   = "jardin/comandos/riego";   // {"segundos":10}
const T_CONFIG      = "jardin/config";           // {"umbral_riego":25,"umbral_prox":60}

// Historial en memoria
const MAX_HISTORIAL = 200;
const historial     = [];          // lecturas de sensores
const alertas       = [];          // alertas recibidas
const visitas       = [];          // detecciones de proximidad
const eventos       = [];          // eventos del sistema

let ultimaLectura   = null;
let ultimaProx      = null;
let riegosHoy       = 0;

// ─────────────────────────────────────────────
// MQTT
// ─────────────────────────────────────────────
const broker = mqtt.connect(MQTT_BROKER, {
  clientId:       MQTT_CLIENT_ID,
  reconnectPeriod: 3000,
  connectTimeout:  10000,
});

broker.on("connect", () => {
  console.error(`[MQTT] Conectado a ${MQTT_BROKER}`);
  broker.subscribe([T_SENSORES, T_ALERTAS, T_EVENTOS, T_PROX], (err) => {
    if (err) console.error("[MQTT] Error al suscribirse:", err.message);
    else     console.error("[MQTT] Suscripto a jardin/#");
  });
});

broker.on("error",       (e) => console.error("[MQTT] Error:", e.message));
broker.on("reconnect",   ()  => console.error("[MQTT] Reconectando..."));
broker.on("offline",     ()  => console.error("[MQTT] Broker offline"));

broker.on("message", (topic, payload) => {
  let data;
  try { data = JSON.parse(payload.toString()); }
  catch { return; }

  const ts = new Date().toISOString();

  if (topic === T_SENSORES) {
    ultimaLectura = { ...data, ts };
    historial.push(ultimaLectura);
    if (historial.length > MAX_HISTORIAL) historial.shift();
    console.error(`[SENSOR] temp:${data.temp}°C hum:${data.hum}% suelo:${data.suelo}% prox:${data.prox ?? "—"}cm`);
  }

  if (topic === T_ALERTAS) {
    const alerta = { ...data, ts };
    alertas.push(alerta);
    if (alertas.length > 50) alertas.shift();
    console.error(`[ALERTA] tipo:${data.tipo} valor:${data.valor}`);
  }

  if (topic === T_PROX) {
    ultimaProx = { ...data, ts };
    if (data.cerca) {
      visitas.push({ distancia: data.distancia_cm, ts });
      if (visitas.length > 100) visitas.shift();
    }
  }

  if (topic === T_EVENTOS) {
    eventos.push({ ...data, ts });
    if (data.evento === "riego_completado") riegosHoy++;
    console.error(`[EVENTO] ${data.evento}`);
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function resumenHistorial(n = 20) {
  const datos = historial.slice(-n);
  if (!datos.length) return null;

  const temps  = datos.map(d => d.temp).filter(Boolean);
  const suelos = datos.map(d => d.suelo).filter(Boolean);
  const luxes  = datos.map(d => d.lux).filter(Boolean);

  return {
    lecturas:       datos.length,
    temp_max:       Math.max(...temps).toFixed(1),
    temp_min:       Math.min(...temps).toFixed(1),
    temp_prom:      (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1),
    suelo_prom:     Math.round(suelos.reduce((a, b) => a + b, 0) / suelos.length),
    suelo_min:      Math.min(...suelos),
    lux_prom:       luxes.length ? Math.round(luxes.reduce((a, b) => a + b, 0) / luxes.length) : null,
    horas_luz:      luxes.filter(l => l > 500).length * (30 / 3600),
    alertas_recientes: alertas.slice(-5),
    riegos_hoy:     riegosHoy,
    visitas_hoy:    visitas.length,
  };
}

function publicar(topic, payload) {
  return new Promise((resolve, reject) => {
    broker.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) reject(err);
      else     resolve();
    });
  });
}

// ─────────────────────────────────────────────
// SERVIDOR MCP
// ─────────────────────────────────────────────
const server = new Server(
  { name: "botanical-twin", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Listado de tools ──
server.setRequestHandler("tools/list", async () => ({
  tools: [

    {
      name: "leer_sensores",
      description:
        "Lee en tiempo real la temperatura, humedad del aire, humedad del suelo y " +
        "distancia del sensor de proximidad. Devuelve la última lectura del ESP32.",
      inputSchema: { type: "object", properties: {} },
    },

    {
      name: "historial_sensores",
      description:
        "Devuelve el historial de lecturas de sensores. Útil para analizar " +
        "si la planta tuvo calor, frío, o falta de agua durante el día.",
      inputSchema: {
        type: "object",
        properties: {
          ultimas_n: {
            type: "number",
            description: "Cantidad de lecturas recientes a devolver (máx 200). Default: 20.",
          },
          formato: {
            type: "string",
            enum: ["resumen", "completo"],
            description: "resumen = estadísticas agregadas. completo = array de lecturas. Default: resumen.",
          },
        },
      },
    },

    {
      name: "regar_planta",
      description:
        "Activa la bomba de agua para regar la planta. " +
        "El ESP32 recibe el comando por MQTT y activa el relay de la bomba. " +
        "Usá este tool cuando el agente decida que la planta necesita agua.",
      inputSchema: {
        type: "object",
        properties: {
          segundos: {
            type: "number",
            description: "Duración del riego en segundos. Rango: 1–30. Recomendado: 5–15.",
          },
          motivo: {
            type: "string",
            description: "Razón del riego (para el log). Ej: 'suelo al 18%, sequía detectada'.",
          },
        },
        required: ["segundos"],
      },
    },

    {
      name: "estado_proximidad",
      description:
        "Devuelve el estado actual del sensor HC-SR04: distancia actual, " +
        "si hay alguien cerca, y el historial de visitas del día.",
      inputSchema: { type: "object", properties: {} },
    },

    {
      name: "resumen_dia",
      description:
        "Genera un resumen completo del día: temperatura máx/mín, horas de luz, " +
        "promedio de humedad del suelo, cantidad de riegos, visitas de proximidad, " +
        "y alertas recibidas.",
      inputSchema: { type: "object", properties: {} },
    },

    {
      name: "configurar_umbrales",
      description:
        "Envía configuración al ESP32: umbral de humedad para alerta de riego " +
        "y umbral de proximidad para detección de presencia.",
      inputSchema: {
        type: "object",
        properties: {
          umbral_suelo_seco: {
            type: "number",
            description: "% de humedad de suelo bajo el cual el ESP32 envía alerta. Default: 25.",
          },
          umbral_prox_cm: {
            type: "number",
            description: "Distancia en cm bajo la cual se considera 'persona cerca'. Default: 60.",
          },
        },
      },
    },

    {
      name: "alertas_recientes",
      description: "Devuelve las últimas alertas enviadas por el ESP32 (calor, frío, suelo seco).",
      inputSchema: {
        type: "object",
        properties: {
          cantidad: { type: "number", description: "Cuántas alertas devolver. Default: 10." },
        },
      },
    },
  ],
}));

// ── Ejecución de tools ──
server.setRequestHandler("tools/call", async (req) => {
  const { name, arguments: args } = req.params;

  // ── leer_sensores ──
  if (name === "leer_sensores") {
    if (!ultimaLectura) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Sin datos aún. El ESP32 publica cada 30 segundos. " +
                   "Verificá que esté encendido y conectado al broker MQTT."
          })
        }]
      };
    }

    const { temp, hum, suelo, lux, prox, ts } = ultimaLectura;
    const estado_suelo =
      suelo < 20  ? "CRÍTICO — necesita riego urgente" :
      suelo < 35  ? "Bajo — considerar riego pronto"   :
      suelo > 80  ? "Saturado — no regar"               : "Óptimo";

    const estado_temp =
      temp > 35   ? "CALOR EXCESIVO — riesgo de estrés" :
      temp < 10   ? "FRÍO EXCESIVO — proteger planta"    : "Normal";

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          temperatura:     `${temp}°C`,
          estado_temp,
          humedad_aire:    `${hum}%`,
          humedad_suelo:   `${suelo}%`,
          estado_suelo,
          luz:             lux ? `${lux} lux` : "sin sensor de luz",
          proximidad:      prox !== undefined ? `${prox} cm` : "sin dato",
          riegos_hoy:      riegosHoy,
          ultima_lectura:  ts,
        }, null, 2)
      }]
    };
  }

  // ── historial_sensores ──
  if (name === "historial_sensores") {
    const n       = Math.min(args?.ultimas_n ?? 20, MAX_HISTORIAL);
    const formato = args?.formato ?? "resumen";

    if (formato === "resumen") {
      const r = resumenHistorial(n);
      if (!r) return { content: [{ type: "text", text: "Sin datos históricos todavía." }] };
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } else {
      const datos = historial.slice(-n);
      return { content: [{ type: "text", text: JSON.stringify(datos, null, 2) }] };
    }
  }

  // ── regar_planta ──
  if (name === "regar_planta") {
    const seg    = Math.min(Math.max(Math.round(args?.segundos ?? 5), 1), 30);
    const motivo = args?.motivo ?? "comando del agente";

    if (!broker.connected) {
      return {
        content: [{
          type: "text",
          text: "Error: no hay conexión con el broker MQTT. No se pudo enviar el comando de riego."
        }]
      };
    }

    try {
      await publicar(T_RIEGO_CMD, { segundos: seg, motivo, ts: new Date().toISOString() });
      console.error(`[RIEGO] Comando enviado: ${seg}s — motivo: ${motivo}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            estado:   "comando_enviado",
            segundos: seg,
            motivo,
            topic:    T_RIEGO_CMD,
            mensaje:  `Bomba activada por ${seg} segundos. El ESP32 confirmará con un evento 'riego_completado'.`
          }, null, 2)
        }]
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error al publicar en MQTT: ${e.message}` }] };
    }
  }

  // ── estado_proximidad ──
  if (name === "estado_proximidad") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          lectura_actual:   ultimaProx ?? "sin datos",
          visitas_registradas: visitas.length,
          ultima_visita:    visitas.slice(-1)[0] ?? null,
          historial_visitas: visitas.slice(-10),
        }, null, 2)
      }]
    };
  }

  // ── resumen_dia ──
  if (name === "resumen_dia") {
    const r = resumenHistorial(MAX_HISTORIAL);
    if (!r) return { content: [{ type: "text", text: "Sin datos suficientes para el resumen del día." }] };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...r,
          visitas_proximidad: visitas.length,
          ultima_visita:      visitas.slice(-1)[0] ?? null,
          alertas_hoy:        alertas.length,
          eventos_hoy:        eventos,
        }, null, 2)
      }]
    };
  }

  // ── configurar_umbrales ──
  if (name === "configurar_umbrales") {
    const config = {};
    if (args?.umbral_suelo_seco !== undefined) config.umbral_riego   = args.umbral_suelo_seco;
    if (args?.umbral_prox_cm    !== undefined) config.umbral_prox    = args.umbral_prox_cm;

    if (!Object.keys(config).length) {
      return { content: [{ type: "text", text: "No se especificó ningún umbral para configurar." }] };
    }

    try {
      await publicar(T_CONFIG, config);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ estado: "configuración_enviada", config }, null, 2)
        }]
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error al enviar configuración: ${e.message}` }] };
    }
  }

  // ── alertas_recientes ──
  if (name === "alertas_recientes") {
    const n    = args?.cantidad ?? 10;
    const data = alertas.slice(-n);
    return {
      content: [{
        type: "text",
        text: data.length
          ? JSON.stringify(data, null, 2)
          : "Sin alertas registradas en esta sesión."
      }]
    };
  }

  return {
    content: [{ type: "text", text: `Tool desconocida: ${name}` }]
  };
});

// ─────────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[MCP] Botanical Twin server iniciado. Esperando conexión del agente...");