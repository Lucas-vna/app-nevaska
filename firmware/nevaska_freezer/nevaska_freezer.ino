/* =============================================================================
 * Nevaska — Firmware do ESP32 (sensor NTC de freezer)
 *
 * O que este firmware faz:
 *  1. Lê a temperatura do NTC a cada 10 s (média de várias amostras + detecção
 *     de sensor rompido/em curto).
 *  2. A cada 60 s envia a média do período por HTTPS para a Vercel
 *     (/api/telemetria). Esse único envio alimenta:
 *       - o PAINEL (que lê o estado guardado no servidor);
 *       - os ALERTAS em segundo plano (Web Push + Telegram);
 *       - a detecção de QUEDA DE ENERGIA: se os envios param de chegar,
 *         o servidor entende que a loja ficou sem energia ou sem internet.
 *
 * Não usa mais MQTT/HiveMQ. Nenhuma biblioteca externa é necessária:
 * só a placa "esp32" by Espressif (core 2.x ou 3.x) na IDE Arduino.
 * ========================================================================== */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <math.h>

// ============================== CONFIGURAÇÃO =================================
// --- Identificação deste freezer (muda em cada placa) ---
const char* LOJA    = "NEVASKA_SC";     // NEVASKA_SC | NEVASKA_BERNARDINO
const char* FREEZER = "freezer_01";     // use só letras, números, _ e -

// --- Wi-Fi da loja ---
const char* WIFI_SSID  = "NOME_DA_REDE";
const char* WIFI_SENHA = "SENHA_DA_REDE";

// --- Vercel ---
const char* URL_TELEMETRIA    = "https://SEU-PROJETO.vercel.app/api/telemetria";
const char* CHAVE_DISPOSITIVO = "MESMO_VALOR_DA_VARIAVEL_DEVICE_KEY_NA_VERCEL";

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
const unsigned long INTERVALO_LEITURA_MS     = 10UL * 1000;      // lê o sensor
const unsigned long INTERVALO_ENVIO_MS       = 60UL * 1000;      // envia para a Vercel (servidor considera offline após 3 min)
const unsigned long REINICIAR_SEM_WIFI_MS    = 10UL * 60 * 1000; // reinicia a placa se ficar 10 min sem Wi-Fi
const int           FALHAS_HTTP_PARA_REINICIAR = 10;             // ~10 min de envios falhando seguidos
// =============================================================================

// Acumulador das leituras entre um envio e outro (o envio manda a média).
float somaLeituras = 0;
int   qtdLeiturasValidas = 0;
int   qtdLeiturasInvalidas = 0;

unsigned long ultimaLeituraMs = 0;
unsigned long ultimoEnvioMs = 0;
unsigned long wifiCaiuEmMs = 0;
bool primeiroEnvioFeito = false;
int  falhasHttpSeguidas = 0;

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

void registrarLeitura() {
  float t = lerTemperatura();
  if (isnan(t)) {
    qtdLeiturasInvalidas++;
    Serial.println("[NTC] SENSOR INVALIDO");
  } else {
    somaLeituras += t;
    qtdLeiturasValidas++;
    Serial.printf("[NTC] %.2f C\n", t);
  }
}

// Média do período. Se TODAS as leituras do período foram inválidas, devolve NAN
// (o servidor transforma isso em alerta de "falha no sensor").
float mediaDoPeriodo() {
  if (qtdLeiturasValidas == 0) {
    if (qtdLeiturasInvalidas == 0) registrarLeitura();  // primeiro envio após ligar
    if (qtdLeiturasValidas == 0) return NAN;
  }
  return somaLeituras / qtdLeiturasValidas;
}

void zerarPeriodo() {
  somaLeituras = 0;
  qtdLeiturasValidas = 0;
  qtdLeiturasInvalidas = 0;
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
// HTTPS → Vercel. Retorna true se o servidor aceitou.
// -----------------------------------------------------------------------------
bool enviarTelemetria(float temp) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure tls;
  // setInsecure() criptografa mas não valida o certificado. Para produção mais
  // rígida, use tls.setCACert(...) com o certificado raiz do domínio da Vercel.
  tls.setInsecure();

  HTTPClient http;
  http.setTimeout(10000);
  http.setConnectTimeout(8000);
  if (!http.begin(tls, URL_TELEMETRIA)) {
    Serial.println("[HTTP] begin falhou");
    return false;
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

  // 401 = DEVICE_KEY errada; 400 = LOJA/FREEZER com caractere inválido.
  return codigo >= 200 && codigo < 300;
}

// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== Nevaska %s / %s ===\n", LOJA, FREEZER);

  analogReadResolution(12);
  // A atenuação padrão do ESP32 já é 11 dB (faixa de 0 a ~3,1 V), ideal para o divisor do NTC.

  conectarWifi();
}

void loop() {
  vigiarWifi();

  unsigned long agora = millis();

  if (agora - ultimaLeituraMs >= INTERVALO_LEITURA_MS) {
    ultimaLeituraMs = agora;
    registrarLeitura();
  }

  // Primeiro envio logo após ligar (avisa o servidor que a energia voltou),
  // depois a cada 60 s.
  if ((!primeiroEnvioFeito || agora - ultimoEnvioMs >= INTERVALO_ENVIO_MS) && WiFi.status() == WL_CONNECTED) {
    ultimoEnvioMs = agora;
    primeiroEnvioFeito = true;

    bool ok = enviarTelemetria(mediaDoPeriodo());
    zerarPeriodo();

    if (ok) {
      falhasHttpSeguidas = 0;
    } else if (++falhasHttpSeguidas >= FALHAS_HTTP_PARA_REINICIAR) {
      // Wi-Fi "conectado" mas sem internet de verdade costuma voltar com um reinício.
      Serial.println("[HTTP] muitas falhas seguidas, reiniciando ESP32");
      ESP.restart();
    }
  }

  delay(10);
}
