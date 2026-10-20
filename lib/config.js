// =============================================================================
// Configuração central dos alertas.
// Tudo vem de variáveis de ambiente da Vercel, então dá para ajustar limites
// sem regravar o firmware e sem mexer no código (basta redeploy).
// =============================================================================

const num = (valor, padrao) => {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
};

const json = (valor, padrao) => {
  if (!valor) return padrao;
  try {
    return JSON.parse(valor);
  } catch {
    console.warn('[config] JSON inválido em variável de ambiente, usando padrão');
    return padrao;
  }
};

export const CONFIG = {
  // Temperatura acima da qual o freezer entra em alerta (°C).
  // Sorvete costuma trabalhar entre -18 °C e -25 °C; -12 °C é um limite de alerta comum.
  limiteTemp: num(process.env.LIMITE_TEMP_C, -12),

  // Limite específico por freezer, sobrescreve o geral.
  // Ex.: {"NEVASKA_SC/freezer_02": -8}  (expositor, que oscila mais)
  limitesPorFreezer: json(process.env.LIMITES_FREEZERS, {}),

  // Para sair do alerta a temperatura precisa cair X graus ABAIXO do limite.
  // Evita o "liga/desliga" de notificações quando fica oscilando no limite.
  histerese: num(process.env.HISTERESE_C, 2),

  // Quanto tempo a temperatura precisa ficar acima do limite antes de alertar.
  // Evita falso alarme quando alguém deixa a porta aberta por um minuto.
  toleranciaMin: num(process.env.TOLERANCIA_MIN, 5),

  // Enquanto o problema continuar, repete o aviso a cada X minutos (0 = não repete).
  repetirMin: num(process.env.REPETIR_ALERTA_MIN, 30),

  // Sem receber dados por X minutos = freezer OFFLINE (queda de energia, Wi-Fi, travamento).
  // O ESP32 envia a cada 60 s, então 3 min = 3 envios perdidos seguidos.
  offlineMin: num(process.env.OFFLINE_MIN, 3),

  // Faixa física plausível do sensor. Fora dela = NTC rompido/em curto.
  sensorMin: num(process.env.SENSOR_MIN_C, -55),
  sensorMax: num(process.env.SENSOR_MAX_C, 60),

  // Nomes amigáveis das lojas para as mensagens.
  nomesLojas: json(process.env.NOMES_LOJAS, {
    NEVASKA_SC: 'Santa Cruz',
    NEVASKA_BERNARDINO: 'Bernardino',
  }),

  // URL que abre ao tocar na notificação.
  urlApp: process.env.APP_URL || '/',
};

export function limiteDe(idFreezer) {
  const especifico = CONFIG.limitesPorFreezer[idFreezer];
  return Number.isFinite(Number(especifico)) && especifico !== null && especifico !== ''
    ? Number(especifico)
    : CONFIG.limiteTemp;
}

export function nomeLoja(loja) {
  return CONFIG.nomesLojas[loja] || loja;
}
