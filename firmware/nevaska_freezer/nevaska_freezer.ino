/* =============================================================================
 * Nevaska — Firmware do ESP32 (sensor NTC de freezer)
 *
 * O que este firmware faz:
 *  1. Lê a temperatura do NTC (média de várias amostras + detecção de sensor
 *     rompido/em curto).
 *  2. A cada 10 s publica no MQTT (HiveMQ) para o painel em tempo real:
 *       sorveteria/<LOJA>/<FREEZER>/temperatura   (retained)
 *       sorveteria/<LOJA>/<FREEZER>/status        "online"/"offline" (retained)
 *     O "offline" é publicado pelo PRÓPRIO BROKER via Last Will (LWT) quando o
 *     ESP32 some (queda de energia, Wi-Fi caiu, travou).
 *  3. A cada 60 s envia a leitura por HTTPS para a Vercel (/api/telemetria).
 *     É ESSE envio que alimenta os alertas em segundo plano. Se ele parar de
 *     chegar, o servidor entende que a loja ficou sem energia/internet.
 *
 * Bibliotecas (Gerenciador de Bibliotecas da IDE Arduino):
 *  - PubSubClient (Nick O'Leary)
 *  - Placa: "esp32" by Espressif (core 2.x ou 3.x)
 *
 * Se você já tem um firmware rodando, o que é NOVO e precisa ser incorporado:
 *  - Last Will no connect() do MQTT  (função conectarMqtt)
 *  - Publicação com retained         (publicarMqtt)
 *  - Envio HTTPS para a Vercel       (enviarTelemetria)
 *  - Detecção de sensor inválido     (lerTemperatura retornando NAN)
 * ========================================================================== */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <HTTPClient.h>
#include <math.h>

// ============================== CONFIGURAÇÃO =================================
// --- Identificação deste freezer (muda em cada placa) ---
const char* LOJA    = "NEVASKA_SC";     // NEVASKA_SC | NEVASKA_BERNARDINO
const char* FREEZER = "freezer_01";

// --- Wi-Fi da loja ---
const char* WIFI_SSID  = "NOME_DA_REDE";
const char* WIFI_SENHA = "SENHA_DA_REDE";

// --- HiveMQ Cloud (MQTT sobre TLS, porta 8883 — a 8884 é a do WebSocket do navegador) ---
const char*    MQTT_HOST    = "ecc7980f7b0c433fbf4b63748514aa36.s1.eu.hivemq.cloud";
const uint16_t MQTT_PORTA   = 8883;
const char*    MQTT_USUARIO = "USUARIO_DOS_DISPOSITIVOS";   // credencial com permissão de PUBLISH
const char*    MQTT_SENHA   = "SENHA_DOS_DISPOSITIVOS";

// --- Vercel (alertas) ---
const char* URL_TELEMETRIA     = "https://SEU-PROJETO.vercel.app/api/telemetria";
const char* CHAVE_DISPOSITIVO  = "MESMO_VALOR_DA_VARIAVEL_DEVICE_KEY_NA_VERCEL";

// --- Sensor NTC ---
// Ligação considerada:  3V3 ── R_SERIE ──┬── NTC ── GND
//                                        └── PINO_NTC (ADC1)
// Se o seu NTC estiver do lado do 3V3 (e o resistor no GND), troque a fórmula
// marcada com [LIGAÇÃO] em lerTemperatura().
const int   PINO_NTC     = 34;       // use pinos do ADC1 (32–39): o ADC2 não funciona com Wi-Fi ligado
// ATENÇÃO AO RESISTOR FIXO: com NTC de 10 kΩ, a -20 °C ele vale ~100 kΩ. Se o resistor
// fixo for de 10 kΩ, a tensão fica em ~3,0 V, colada na saturação do ADC do ESP32
// (~3,1 V): a leitura perde precisão e um fio rompido fica parecendo "-30 °C".
// Para a faixa de freezer use um resistor fixo de 100 kΩ (ou 47 kΩ) — a -20 °C a
// tensão fica perto de 1,7 V, no meio da faixa. Coloque aqui o valor REAL da sua placa.
const float R_SERIE      = 100000.0; // resistor fixo do divisor (Ω)
const float R_NOMINAL    = 10000.0;  // resistência do NTC a 25 °C (Ω)
const float T_NOMINAL_C  = 25.0;
const float BETA         = 3950.0;   // coeficiente Beta do seu NTC (veja o datasheet)
const float OFFSET_C     = 0.0;      // calibração fina (compare com um termômetro de referência)
const int   AMOSTRAS     = 32;

// --- Intervalos ---
const unsigned long INTERVALO_MQTT_MS  = 10UL * 1000;   // painel em tempo real
const unsigned long INTERVALO_HTTP_MS  = 60UL * 1000;   // heartbeat dos alertas (servidor considera offline após 3 min)
const unsigned long REINICIAR_SEM_WIFI_MS = 10UL * 60 * 1000; // reinicia a placa se ficar 10 min sem Wi-Fi
// =============================================================================

WiFiClientSecure tlsMqtt;
PubSubClient mqtt(tlsMqtt);

String topicoTemperatura;
String topicoStatus;

float ultimaTemp = NAN;
unsigned long ultimaLeituraMs = 0;
unsigned long ultimoEnvioHttpMs = 0;
unsigned long ultimaTentativaMqttMs = 0;
unsigned long wifiCaiuEmMs = 0;
bool primeiroEnvioFeito = false;

// -----------------------------------------------------------------------------
// Leitura do NTC. Retorna NAN se o sensor estiver aberto ou em curto.
// -----------------------------------------------------------------------------
float lerTemperatura() {
  uint32_t somaMv = 0;
  for (int i = 0; i < AMOSTRAS; i++) {
    somaMv += analogReadMilliVolts(PINO_NTC);  // já corrigido pela calibração de fábrica do ESP32
    delay(2);
  }
  float mv = somaMv / (float)AMOSTRAS;
  const float VCC_MV = 3300.0;

  // Perto de 0 V = NTC em curto; perto da saturação do ADC (~3,1 V) = NTC desconectado.
  // Melhor avisar "sensor com falha" do que mandar uma temperatura falsa.
  if (mv < 50.0 || mv > 3050.0) return NAN;

  // [LIGAÇÃO] NTC no lado do GND:
  float rNtc = R_SERIE * mv / (VCC_MV - mv);
  // [LIGAÇÃO] Se o NTC estiver no lado do 3V3, use:  float rNtc = R_SERIE * (VCC_MV - mv) / mv;

  // Equação Beta: 1/T = 1/T0 + (1/B) * ln(R/R0)
  float invT = (1.0 / (T_NOMINAL_C + 273.15)) + (1.0 / BETA) * log(rNtc / R_NOMINAL);
  float tempC = (1.0 / invT) - 273.15 + OFFSET_C;

  if (tempC < -55.0 || tempC > 60.0) return NAN;
  return tempC;
}

// -----------------------------------------------------------------------------
// Wi-Fi
// -----------------------------------------------------------------------------
void conectarWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  Serial.print("[WiFi] conectando");
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 20000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf(" ok, IP %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(" falhou (o loop continua tentando)");
  }
}

void vigiarWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiCaiuEmMs = 0;
    return;
  }
  if (wifiCaiuEmMs == 0) {
    wifiCaiuEmMs = millis();
    Serial.println("[WiFi] caiu, tentando reconectar...");
    WiFi.reconnect();
  }
  // Rede travada às vezes só volta reiniciando a placa.
  if (millis() - wifiCaiuEmMs > REINICIAR_SEM_WIFI_MS) {
    Serial.println("[WiFi] muito tempo sem rede, reiniciando ESP32");
    ESP.restart();
  }
}

// -----------------------------------------------------------------------------
// MQTT com Last Will: se o ESP32 sumir, o BROKER publica "offline" sozinho.
// -----------------------------------------------------------------------------
void conectarMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - ultimaTentativaMqttMs < 5000) return;  // não martela o broker
  ultimaTentativaMqttMs = millis();

  String clientId = String("esp32_") + LOJA + "_" + FREEZER;
  Serial.print("[MQTT] conectando... ");

  bool ok = mqtt.connect(
    clientId.c_str(),
    MQTT_USUARIO, MQTT_SENHA,
    topicoStatus.c_str(),  // tópico do Last Will
    1,                     // QoS do Last Will
    true,                  // retained: quem abrir o painel depois já vê "offline"
    "offline"              // mensagem do Last Will
  );

  if (ok) {
    Serial.println("ok");
    mqtt.publish(topicoStatus.c_str(), "online", true);  // retained
  } else {
    Serial.printf("falhou, rc=%d\n", mqtt.state());
  }
}

void publicarMqtt(float temp) {
  if (!mqtt.connected()) return;
  char payload[16];
  if (isnan(temp)) strcpy(payload, "erro");
  else snprintf(payload, sizeof(payload), "%.2f", temp);
  mqtt.publish(topicoTemperatura.c_str(), payload, true);  // retained
}

// -----------------------------------------------------------------------------
// HTTPS → Vercel. É isto que garante os alertas com o celular bloqueado.
// -----------------------------------------------------------------------------
void enviarTelemetria(float temp) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure tls;
  // setInsecure() criptografa mas não valida o certificado. Para produção mais
  // rígida, use tls.setCACert(...) com o certificado raiz do domínio da Vercel.
  tls.setInsecure();

  HTTPClient http;
  http.setTimeout(10000);
  http.setConnectTimeout(8000);
  if (!http.begin(tls, URL_TELEMETRIA)) {
    Serial.println("[HTTP] begin falhou");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-chave-dispositivo", CHAVE_DISPOSITIVO);

  char corpo[160];
  if (isnan(temp)) {
    snprintf(corpo, sizeof(corpo), "{\"loja\":\"%s\",\"freezer\":\"%s\",\"temp\":null}", LOJA, FREEZER);
  } else {
    snprintf(corpo, sizeof(corpo), "{\"loja\":\"%s\",\"freezer\":\"%s\",\"temp\":%.2f}", LOJA, FREEZER, temp);
  }

  int codigo = http.POST((uint8_t*)corpo, strlen(corpo));
  if (codigo > 0) {
    Serial.printf("[HTTP] %d %s\n", codigo, http.getString().c_str());
  } else {
    Serial.printf("[HTTP] erro: %s\n", http.errorToString(codigo).c_str());
  }
  http.end();
}

// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== Nevaska %s / %s ===\n", LOJA, FREEZER);

  analogReadResolution(12);
  // A atenuação padrão do ESP32 já é 11 dB (faixa de 0 a ~3,1 V), ideal para o divisor do NTC.

  topicoTemperatura = String("sorveteria/") + LOJA + "/" + FREEZER + "/temperatura";
  topicoStatus      = String("sorveteria/") + LOJA + "/" + FREEZER + "/status";

  conectarWifi();

  tlsMqtt.setInsecure();  // ver comentário em enviarTelemetria()
  mqtt.setServer(MQTT_HOST, MQTT_PORTA);
  mqtt.setKeepAlive(20);   // broker detecta queda em ~30 s e publica o Last Will
  mqtt.setSocketTimeout(10);

  ultimaTemp = lerTemperatura();
}

void loop() {
  vigiarWifi();
  conectarMqtt();
  mqtt.loop();

  unsigned long agora = millis();

  if (agora - ultimaLeituraMs >= INTERVALO_MQTT_MS) {
    ultimaLeituraMs = agora;
    ultimaTemp = lerTemperatura();
    if (isnan(ultimaTemp)) Serial.println("[NTC] SENSOR INVALIDO");
    else Serial.printf("[NTC] %.2f C\n", ultimaTemp);
    publicarMqtt(ultimaTemp);
  }

  // Primeiro envio logo após ligar (avisa o servidor que a energia voltou),
  // depois a cada 60 s.
  if (!primeiroEnvioFeito || agora - ultimoEnvioHttpMs >= INTERVALO_HTTP_MS) {
    if (WiFi.status() == WL_CONNECTED) {
      ultimoEnvioHttpMs = agora;
      primeiroEnvioFeito = true;
      enviarTelemetria(ultimaTemp);
    }
  }

  delay(10);
}
