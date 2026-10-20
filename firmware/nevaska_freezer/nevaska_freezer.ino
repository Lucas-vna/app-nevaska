/* =============================================================================
 * Nevaska — Firmware do ESP32 (sensor DS18B20 + display OLED + LEDs)
 *
 * Baseado no código de teste original, trocando o HiveMQ pelo envio para a Vercel.
 *
 * O que este firmware faz:
 *  1. Lê o DS18B20 a cada 5 s e atualiza o display OLED e os LEDs.
 *  2. A cada 60 s envia a média do período por HTTPS para a Vercel
 *     (/api/telemetria). Esse envio alimenta o painel, os alertas no celular
 *     e a detecção de queda de energia (se os envios param, o servidor avisa).
 *  3. O limite de alerta usado no display/LEDs vem do servidor (variável
 *     LIMITE_TEMP_C na Vercel). Não precisa regravar a placa para mudar o limite.
 *  4. A última linha do display mostra se a comunicação com o servidor está ok.
 *
 * Bibliotecas (Gerenciador de Bibliotecas da IDE Arduino):
 *  - OneWire
 *  - DallasTemperature
 *  - Adafruit GFX Library
 *  - Adafruit SSD1306
 *  - Placa: "esp32" by Espressif
 *  (A PubSubClient não é mais usada.)
 * ========================================================================== */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <math.h>

// ======================= CONFIGURAÇÕES DA REDE WI-FI =========================
// Use a rede de 2.4 GHz (o ESP32 não conecta em redes 5 GHz).
const char* WIFI_SSID = "NOME_DA_REDE";
const char* WIFI_PASS = "SENHA_DA_REDE";

// ======================= CONFIGURAÇÕES DO SERVIDOR (VERCEL) ==================
const char* URL_TELEMETRIA    = "https://app-nevaska-seven.vercel.app/api/telemetria";
const char* CHAVE_DISPOSITIVO = "COLE_AQUI_O_VALOR_DA_DEVICE_KEY_DA_VERCEL";

// =======================================================================
// AQUI VOCÊ DEFINE O FREEZER (MUDE APENAS ESTAS DUAS LINHAS PARA CADA PLACA)
// Lojas: "NEVASKA_SC" ou "NEVASKA_BERNARDINO"
// Freezers: "freezer_01", "freezer_02", "freezer_03", etc.
// Use só letras, números, _ e - (sem espaço). Cada placa da mesma loja
// precisa de um FREEZER_ID diferente.
// =======================================================================
const char* LOJA_ID    = "NEVASKA_SC";
const char* FREEZER_ID = "freezer_01";

// ======================= CONFIGURAÇÕES DO HARDWARE ===========================
const int PIN_DS18B20      = 4;
const int PIN_LED_VERDE    = 26;
const int PIN_LED_VERMELHO = 27;

// Limite usado no display/LEDs ATÉ o servidor responder pela primeira vez.
// Depois disso vale o limite que está na Vercel (LIMITE_TEMP_C).
float limiteAlerta = 30.0;

// ======================= INTERVALOS ==========================================
const unsigned long INTERVALO_LEITURA_MS       = 5UL * 1000;       // lê o sensor e atualiza o display
const unsigned long INTERVALO_ENVIO_MS         = 60UL * 1000;      // envia para a Vercel
const unsigned long REINICIAR_SEM_WIFI_MS      = 10UL * 60 * 1000; // reinicia se ficar 10 min sem Wi-Fi
const int           FALHAS_HTTP_PARA_REINICIAR = 10;               // ~10 min de envios falhando seguidos

// ======================= DISPLAY OLED ========================================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool displayOk = false;

// ======================= INSTÂNCIAS E VARIÁVEIS ==============================
OneWire oneWire(PIN_DS18B20);
DallasTemperature sensors(&oneWire);

// Acumulador das leituras entre um envio e outro (o envio manda a média).
float somaLeituras = 0;
int   qtdLeiturasValidas = 0;

float ultimaTemp = NAN;
unsigned long ultimaLeituraMs = 0;
unsigned long ultimoEnvioMs = 0;
unsigned long wifiCaiuEmMs = 0;
bool primeiroEnvioFeito = false;
int  falhasHttpSeguidas = 0;
int  ultimoCodigoHttp = 0;   // 0 = ainda não enviou; usado na última linha do display

// -----------------------------------------------------------------------------
// Sensor DS18B20. Retorna NAN se estiver desconectado ou com leitura inválida.
// -----------------------------------------------------------------------------
float lerTemperatura() {
  sensors.requestTemperatures();
  float t = sensors.getTempCByIndex(0);
  // -127 = sensor desconectado. 85 = valor de "reset" do DS18B20 (falha de alimentação/fio).
  if (t == DEVICE_DISCONNECTED_C || t == 85.0 || t < -55.0 || t > 125.0) return NAN;
  return t;
}

void registrarLeitura(float t) {
  if (!isnan(t)) {
    somaLeituras += t;
    qtdLeiturasValidas++;
  }
}

// Média do período. Se nenhuma leitura do período foi válida, devolve NAN
// (o servidor transforma isso em alerta de "falha no sensor").
float mediaDoPeriodo() {
  if (qtdLeiturasValidas == 0) return NAN;
  return somaLeituras / qtdLeiturasValidas;
}

void zerarPeriodo() {
  somaLeituras = 0;
  qtdLeiturasValidas = 0;
}

// -----------------------------------------------------------------------------
// LEDs e display
// -----------------------------------------------------------------------------
bool emAlerta(float t) {
  return isnan(t) || t > limiteAlerta;
}

void atualizarLeds(float t) {
  bool alerta = emAlerta(t);
  digitalWrite(PIN_LED_VERDE, alerta ? LOW : HIGH);
  digitalWrite(PIN_LED_VERMELHO, alerta ? HIGH : LOW);
}

String textoConexao() {
  if (WiFi.status() != WL_CONNECTED) return "Wi-Fi: sem conexao";
  if (ultimoCodigoHttp == 0)         return "Nuvem: conectando...";
  if (ultimoCodigoHttp == 200)       return "Nuvem: OK";
  if (ultimoCodigoHttp == 401)       return "Nuvem: chave errada";
  if (ultimoCodigoHttp < 0)          return "Nuvem: sem internet";
  return "Nuvem: erro " + String(ultimoCodigoHttp);
}

void atualizarDisplay(float t) {
  if (!displayOk) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Linhas 1 e 2: identificação
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(LOJA_ID);
  display.println(FREEZER_ID);

  // Temperatura em destaque
  display.setTextSize(2);
  display.setCursor(0, 20);
  if (isnan(t)) {
    display.print("-- C");
  } else {
    display.print(t, 1);
    display.print(" C");
  }

  // Situação da temperatura
  display.setTextSize(1);
  display.setCursor(0, 42);
  if (isnan(t))               display.print("ERRO NO SENSOR!");
  else if (t > limiteAlerta)  display.print("ALERTA: TEMP. ALTA!");
  else                        display.print("TEMPERATURA NORMAL");

  // Comunicação com o servidor
  display.setCursor(0, 54);
  display.print(textoConexao());

  display.display();
}

void mostrarMensagem(const char* linha1, const char* linha2) {
  if (!displayOk) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(LOJA_ID);
  display.println(FREEZER_ID);
  display.println("");
  display.println(linha1);
  display.println(linha2);
  display.display();
}

// -----------------------------------------------------------------------------
// Wi-Fi (não trava a placa se a rede cair: o display continua funcionando)
// -----------------------------------------------------------------------------
void conectarWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Conectando ao Wi-Fi: ");
  Serial.println(WIFI_SSID);
  mostrarMensagem("Conectando Wi-Fi...", WIFI_SSID);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 20000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWi-Fi conectado! IP %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWi-Fi nao conectou ainda (o loop continua tentando).");
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
  if (millis() - wifiCaiuEmMs > REINICIAR_SEM_WIFI_MS) {
    Serial.println("[WiFi] muito tempo sem rede, reiniciando ESP32");
    ESP.restart();
  }
}

// -----------------------------------------------------------------------------
// HTTPS → Vercel. Retorna o código HTTP (negativo = erro de conexão).
// -----------------------------------------------------------------------------
int enviarTelemetria(float temp) {
  WiFiClientSecure tls;
  // setInsecure() criptografa mas não valida o certificado (mesmo esquema do código original).
  tls.setInsecure();

  HTTPClient http;
  http.setTimeout(10000);
  http.setConnectTimeout(8000);
  if (!http.begin(tls, URL_TELEMETRIA)) {
    Serial.println("[HTTP] begin falhou (confira a URL)");
    return -1;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-chave-dispositivo", CHAVE_DISPOSITIVO);

  char corpo[160];
  if (isnan(temp)) {
    snprintf(corpo, sizeof(corpo), "{\"loja\":\"%s\",\"freezer\":\"%s\",\"temp\":null}", LOJA_ID, FREEZER_ID);
  } else {
    snprintf(corpo, sizeof(corpo), "{\"loja\":\"%s\",\"freezer\":\"%s\",\"temp\":%.2f}", LOJA_ID, FREEZER_ID, temp);
  }

  int codigo = http.POST((uint8_t*)corpo, strlen(corpo));
  if (codigo > 0) {
    String resposta = http.getString();
    Serial.printf("[HTTP] %d %s\n", codigo, resposta.c_str());

    // Pega o limite de alerta que o servidor devolve: ..."limite":-12,...
    int pos = resposta.indexOf("\"limite\":");
    if (codigo == 200 && pos >= 0) {
      String resto = resposta.substring(pos + 9);
      char c = resto.length() ? resto.charAt(0) : ' ';
      if (c == '-' || (c >= '0' && c <= '9')) {
        float novoLimite = resto.toFloat();
        if (novoLimite != limiteAlerta) {
          Serial.printf("[HTTP] limite de alerta atualizado: %.1f C\n", novoLimite);
          limiteAlerta = novoLimite;
        }
      }
    }
  } else {
    Serial.printf("[HTTP] erro: %s\n", http.errorToString(codigo).c_str());
  }
  http.end();
  return codigo;
}

// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== Nevaska %s / %s ===\n", LOJA_ID, FREEZER_ID);

  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_VERMELHO, OUTPUT);

  sensors.begin();

  // Se o display falhar, a placa CONTINUA monitorando (antes ela travava aqui).
  displayOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!displayOk) {
    Serial.println("Erro ao iniciar o display OLED (seguindo sem display)");
  }
  mostrarMensagem("Iniciando...", "");
  delay(1500);

  conectarWifi();
}

void loop() {
  vigiarWifi();

  unsigned long agora = millis();

  // ---------- Leitura do sensor + display + LEDs (a cada 5 s) ----------
  if (agora - ultimaLeituraMs >= INTERVALO_LEITURA_MS || ultimaLeituraMs == 0) {
    ultimaLeituraMs = agora;
    ultimaTemp = lerTemperatura();
    registrarLeitura(ultimaTemp);

    Serial.print("[");
    Serial.print(LOJA_ID);
    Serial.print(" - ");
    Serial.print(FREEZER_ID);
    Serial.print("] Temperatura: ");
    if (isnan(ultimaTemp)) Serial.println("ERRO NO SENSOR");
    else { Serial.print(ultimaTemp, 2); Serial.println(" C"); }

    atualizarLeds(ultimaTemp);
    atualizarDisplay(ultimaTemp);
  }

  // ---------- Envio para a Vercel (logo ao ligar e depois a cada 60 s) ----------
  if ((!primeiroEnvioFeito || agora - ultimoEnvioMs >= INTERVALO_ENVIO_MS) && WiFi.status() == WL_CONNECTED) {
    ultimoEnvioMs = agora;
    primeiroEnvioFeito = true;

    ultimoCodigoHttp = enviarTelemetria(mediaDoPeriodo());
    zerarPeriodo();
    atualizarDisplay(ultimaTemp);

    if (ultimoCodigoHttp >= 200 && ultimoCodigoHttp < 300) {
      falhasHttpSeguidas = 0;
    } else if (++falhasHttpSeguidas >= FALHAS_HTTP_PARA_REINICIAR) {
      // Wi-Fi "conectado" mas sem internet de verdade costuma voltar com um reinício.
      Serial.println("[HTTP] muitas falhas seguidas, reiniciando ESP32");
      ESP.restart();
    }
  }

  delay(10);
}
