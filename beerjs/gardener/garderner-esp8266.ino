#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "DHT.h"

// Configuracion de red (editar segun tu entorno)
const char* WIFI_SSID = "A65";
const char* WIFI_PASS = "wireless";
const char* MQTT_HOST = "192.168.1.7";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_CLIENT_ID = "gardener-esp8266";

// Topics
const char* T_SENSORES = "jardin/sensores";
const char* T_EVENTOS = "jardin/eventos";
const char* T_PROX = "jardin/proximidad";
const char* T_RIEGO_CMD = "jardin/comandos/riego";

// Configuracion de Pines
#define DHTPIN 2      // D4
#define DHTTYPE DHT22
#define TRIG_PIN 5    // D1
#define ECHO_PIN 4    // D2
#define BOMBA_PIN 12  // D6

const unsigned long SENSOR_INTERVAL_MS = 10000;
const unsigned long MQTT_RETRY_MS = 3000;
const float DISTANCE_DELTA_CM = 20.0f;
const int MAX_RIEGO_SECONDS = 2;

DHT dht(DHTPIN, DHTTYPE);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

unsigned long ultimaLectura = 0;
unsigned long ultimoMqttIntento = 0;
unsigned long riegoHastaMs = 0;
bool riegoActivo = false;
bool distanciaLeidaInicializada = false;
float ultimaDistanciaLeida = 0.0f;

void iniciarRiego(int segundos, const char* motivo) {
  int seg = constrain(segundos, 1, MAX_RIEGO_SECONDS);
  riegoHastaMs = millis() + (unsigned long)seg * 1000UL;
  riegoActivo = true;
  digitalWrite(BOMBA_PIN, HIGH);

  StaticJsonDocument<192> ev;
  ev["evento"] = "riego_iniciado";
  ev["segundos"] = seg;
  ev["motivo"] = motivo;
  ev["source"] = "esp8266";
  ev["max_segundos"] = MAX_RIEGO_SECONDS;
  String out;
  serializeJson(ev, out);
  mqttClient.publish(T_EVENTOS, out.c_str(), true);

  Serial.printf("[RIEGO] Iniciado por %d s (max %d) | motivo=%s\n", seg, MAX_RIEGO_SECONDS, motivo);
}

void detenerRiego() {
  digitalWrite(BOMBA_PIN, LOW);
  riegoActivo = false;

  StaticJsonDocument<128> ev;
  ev["evento"] = "riego_completado";
  ev["source"] = "esp8266";
  String out;
  serializeJson(ev, out);
  mqttClient.publish(T_EVENTOS, out.c_str(), true);

  Serial.println(F("[RIEGO] Completado"));
}

float medirDistanciaCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duracion = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (duracion == 0) {
    return -1.0;
  }
  return duracion * 0.0343f / 2.0f;
}

void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.printf("[WIFI] Conectando a %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000UL) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WIFI] OK. IP=%s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("[WIFI] No conectado. Reintentando en loop"));
  }
}

void publicarSensores() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println(F("[DHT] Lectura invalida"));
    return;
  }

  int valorSuelo = analogRead(A0);
  int porcSuelo = constrain(map(valorSuelo, 1024, 680, 0, 100), 0, 100);
  float distancia = medirDistanciaCm();
  bool publicarDistancia = false;

  if (distancia > 0) {
    if (!distanciaLeidaInicializada) {
      distanciaLeidaInicializada = true;
      publicarDistancia = true;
    } else if (fabsf(distancia - ultimaDistanciaLeida) >= DISTANCE_DELTA_CM) {
      publicarDistancia = true;
    }
    ultimaDistanciaLeida = distancia;
  }

  StaticJsonDocument<256> doc;
  doc["temp"] = roundf(t * 10.0f) / 10.0f;
  doc["hum"] = roundf(h * 10.0f) / 10.0f;
  doc["suelo"] = porcSuelo;
  if (publicarDistancia) {
    doc["dist"] = roundf(distancia * 10.0f) / 10.0f;
    doc["distancia_cm"] = roundf(distancia * 10.0f) / 10.0f;
  }

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(T_SENSORES, payload.c_str(), false);

  if (publicarDistancia) {
    StaticJsonDocument<128> prox;
    prox["distancia_cm"] = roundf(distancia * 10.0f) / 10.0f;
    prox["cerca"] = distancia < 60.0f;
    String p;
    serializeJson(prox, p);
    mqttClient.publish(T_PROX, p.c_str(), false);
    Serial.printf("[PROX] Publicada distancia %.1fcm (delta >= %.1fcm vs lectura anterior)\n", distancia, DISTANCE_DELTA_CM);
  }

  Serial.printf("[SENSOR] valorSueloRaw=%d T=%.1fC H=%.1f%% Suelo=%d%% Dist=%.1fcm\n", valorSuelo, t, h, porcSuelo, distancia);
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<192> req;
  DeserializationError err = deserializeJson(req, payload, length);
  if (err) {
    Serial.printf("[MQTT] JSON invalido en %s\n", topic);
    return;
  }

  if (strcmp(topic, T_RIEGO_CMD) == 0) {
    int segundos = req["segundos"] | MAX_RIEGO_SECONDS;
    const char* motivo = req["motivo"] | "manual_dashboard";
    iniciarRiego(segundos, motivo);
  }
}

void conectarMQTT() {
  if (mqttClient.connected()) {
    return;
  }
  if (millis() - ultimoMqttIntento < MQTT_RETRY_MS) {
    return;
  }
  ultimoMqttIntento = millis();

  Serial.printf("[MQTT] Conectando a %s:%u ...\n", MQTT_HOST, MQTT_PORT);
  if (mqttClient.connect(MQTT_CLIENT_ID)) {
    Serial.println(F("[MQTT] Conectado"));
    mqttClient.subscribe(T_RIEGO_CMD);

    StaticJsonDocument<128> ev;
    ev["evento"] = "esp8266_online";
    ev["ip"] = WiFi.localIP().toString();
    String p;
    serializeJson(ev, p);
    mqttClient.publish(T_EVENTOS, p.c_str(), true);
  } else {
    Serial.printf("[MQTT] Error rc=%d\n", mqttClient.state());
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);

  dht.begin();
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BOMBA_PIN, OUTPUT);
  digitalWrite(BOMBA_PIN, LOW);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);

  Serial.println(F("--- GARDENER ESP8266 MQTT ---"));
  conectarWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
  }

  conectarMQTT();
  mqttClient.loop();

  if (riegoActivo && (long)(millis() - riegoHastaMs) >= 0) {
    detenerRiego();
  }

  if (mqttClient.connected() && millis() - ultimaLectura >= SENSOR_INTERVAL_MS) {
    ultimaLectura = millis();
    publicarSensores();
  }

  delay(20);
}