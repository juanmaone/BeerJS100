import mqtt, { MqttClient } from "mqtt";
import { FastMCP } from "fastmcp";
import { z } from "zod";

type SensorReading = {
  temp: number;
  hum: number;
  receivedAt: Date;
};

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC ?? "#";
const MQTT_RECONNECT_PERIOD_MS = 5000;

const server = new FastMCP({
  name: "BeerJS Weather-Server",
  version: "3.0.0",
});

let latestSensorReading: SensorReading | null = null;
let mqttClient: MqttClient | null = null;
let mqttStarted = false;

function parseSensorReading(payload: Buffer | string): SensorReading | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload.toString());
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("temp" in parsed) ||
    !("hum" in parsed)
  ) {
    return null;
  }

  const temp = (parsed as { temp: unknown }).temp;
  const hum = (parsed as { hum: unknown }).hum;

  if (typeof temp !== "number" || typeof hum !== "number") {
    return null;
  }

  return {
    temp,
    hum,
    receivedAt: new Date(),
  };
}

function rememberLatestReading(payload: Buffer | string) {
  const reading = parseSensorReading(payload);
  if (!reading) {
    return;
  }

  latestSensorReading = reading;
}

function startMqttSubscription() {
  if (mqttStarted) {
    return;
  }

  mqttStarted = true;

  mqttClient = mqtt.connect(MQTT_URL, {
    reconnectPeriod: MQTT_RECONNECT_PERIOD_MS,
    connectTimeout: 10_000,
    keepalive: 30,
    clean: true,
  });

  mqttClient.on("connect", () => {
    console.error(`[mqtt] conectado a ${MQTT_URL}`);

    mqttClient?.subscribe(MQTT_TOPIC, { qos: 0 }, (error) => {
      if (error) {
        console.error(`[mqtt] error al suscribirse a ${MQTT_TOPIC}:`, error);
        return;
      }

      console.error(`[mqtt] suscrito a ${MQTT_TOPIC}`);
    });
  });

  mqttClient.on("message", (_topic, payload) => {
    rememberLatestReading(payload);
  });

  mqttClient.on("reconnect", () => {
    console.error("[mqtt] reconectando...");
  });

  mqttClient.on("offline", () => {
    console.error("[mqtt] cliente offline");
  });

  mqttClient.on("close", () => {
    console.error("[mqtt] conexión cerrada, seguirá intentando reconectar");
  });

  mqttClient.on("error", (error) => {
    console.error("[mqtt] error:", error);
  });
}

function formatTemperature(tempC: number, unit: "C" | "F") {
  if (unit === "F") {
    return `${((tempC * 9) / 5 + 32).toFixed(1)}°F`;
  }

  return `${tempC.toFixed(1)}°C`;
}

function formatWeatherReading(unit: "C" | "F") {
  if (!latestSensorReading) {
    return "Todavía no llegó ninguna lectura del DHT22 por MQTT. Esperando el próximo mensaje.";
  }

  const temperature = formatTemperature(latestSensorReading.temp, unit);
  const humidity = `${latestSensorReading.hum.toFixed(1)}%`;
  const time = latestSensorReading.receivedAt.toLocaleTimeString("es-AR");

  return `Última lectura del DHT22: temperatura ${temperature} y humedad ${humidity}. Recibida a las ${time}.`;
}

server.addTool({
  name: "get_beerjs_fake_weather",
  description: "Devuelve una temperatura ficticia para BeerJS.",
  parameters: z.object({
    city: z.string().describe("Temperatura de la BeerJS RANDMOM"),
    unit: z.enum(["C", "F"]).default("C").describe("Unidad de temperatura"),
  }),
  execute: async ({ unit }) => {
    const temp = Math.floor(Math.random() * 30) + 10;
    const condition = ["Soleado", "Nublado", "Lluvia"][Math.floor(Math.random() * 3)];

    return {
      content: [
        {
          type: "text",
          text: `En BeerJS hace ${temp}°${unit} y está ${condition}.`,
        },
      ],
    };
  },
});

server.addTool({
  name: "get_beerjs_real_weather",
  description: "Obtiene temperatura y humedad de la BEERJS 100, Devuelve la última lectura real del sensor DHT22 publicada por MQTT local.",
  parameters: z.object({
    unit: z.enum(["C", "F"]).default("C").describe("Unidad de temperatura"),
  }),
  execute: async ({ unit }) => {
    return {
      content: [
        {
          type: "text",
          text: formatWeatherReading(unit),
        },
      ],
    };
  },
});

startMqttSubscription();

server.start();


/***
 * // 1. Script Local (Default)
server.start(); 

// 2. Microservicio (SSE)
// Esto levanta un servidor HTTP real que escucha peticiones externas
server.start({
  transportType: "sse",
  sse: {
    endpoint: "/mcp", // La ruta donde escuchará la IA
    port: 3000        // El puerto del microservicio
  }
});
 * 
 */