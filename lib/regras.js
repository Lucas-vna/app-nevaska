// =============================================================================
// Regras de alerta — funções PURAS (sem banco, sem rede).
// Recebem o estado anterior do freezer + a novidade e devolvem:
//   - "novo": campos a gravar no banco
//   - "eventos": o que precisa ser notificado
// Por serem puras, dá para testar tudo com `npm test` sem infraestrutura.
// =============================================================================

const MIN = 60 * 1000;

// Converte o que vem do banco (strings/números/booleanos/undefined) em tipos previsíveis.
export function normalizarEstado(bruto = {}) {
  const n = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);
  const temp = bruto.temp === undefined || bruto.temp === null || bruto.temp === '' ? null : Number(bruto.temp);
  return {
    temp: Number.isFinite(temp) ? temp : null,
    lastSeen: n(bruto.lastSeen),
    acimaDesde: n(bruto.acimaDesde),
    tempAlerta: n(bruto.tempAlerta) === 1,
    ultimoAvisoTemp: n(bruto.ultimoAvisoTemp),
    offlineAlerta: n(bruto.offlineAlerta) === 1,
    offlineDesde: n(bruto.offlineDesde),
    ultimoAvisoOffline: n(bruto.ultimoAvisoOffline),
    sensorFalha: n(bruto.sensorFalha) === 1,
  };
}

/**
 * Avalia uma leitura de temperatura recebida do ESP32.
 * @param {object} estadoBruto  estado salvo no banco
 * @param {number} temp         temperatura em °C (NaN se o sensor falhou)
 * @param {number} agora        Date.now()
 * @param {object} cfg          CONFIG
 * @param {number} limite       limite deste freezer
 */
export function avaliarLeitura(estadoBruto, temp, agora, cfg, limite) {
  const e = normalizarEstado(estadoBruto);
  const novo = { lastSeen: agora };
  const eventos = [];

  // 1) Chegou dado: se estava marcado como offline, avisa que voltou.
  if (e.offlineAlerta) {
    eventos.push({
      tipo: 'online',
      minutosFora: e.offlineDesde ? Math.round((agora - e.offlineDesde) / MIN) : null,
    });
    novo.offlineAlerta = 0;
    novo.offlineDesde = 0;
  }

  // 2) Sensor com leitura impossível (NTC solto, rompido ou em curto).
  const leituraValida = Number.isFinite(temp) && temp >= cfg.sensorMin && temp <= cfg.sensorMax;
  if (!leituraValida) {
    if (!e.sensorFalha) {
      eventos.push({ tipo: 'sensor_falha', valor: Number.isFinite(temp) ? temp : null });
      novo.sensorFalha = 1;
    }
    // Não sobrescreve a última temperatura boa e não mexe no alerta de temperatura.
    return { novo, eventos };
  }

  if (e.sensorFalha) {
    eventos.push({ tipo: 'sensor_ok', temp });
    novo.sensorFalha = 0;
  }
  novo.temp = temp;

  // 3) Regra de temperatura com tolerância (tempo mínimo acima) e histerese.
  if (temp > limite) {
    const acimaDesde = e.acimaDesde || agora;
    novo.acimaDesde = acimaDesde;
    const minutosAcima = Math.round((agora - acimaDesde) / MIN);

    if (!e.tempAlerta) {
      if (agora - acimaDesde >= cfg.toleranciaMin * MIN) {
        eventos.push({ tipo: 'temp_alta', temp, limite, minutosAcima });
        novo.tempAlerta = 1;
        novo.ultimoAvisoTemp = agora;
      }
    } else if (cfg.repetirMin > 0 && agora - e.ultimoAvisoTemp >= cfg.repetirMin * MIN) {
      eventos.push({ tipo: 'temp_alta_persiste', temp, limite, minutosAcima });
      novo.ultimoAvisoTemp = agora;
    }
  } else if (e.tempAlerta) {
    // Está em alerta e voltou para baixo do limite: só normaliza depois da histerese.
    if (temp <= limite - cfg.histerese) {
      eventos.push({
        tipo: 'temp_normal',
        temp,
        minutosEmAlerta: e.acimaDesde ? Math.round((agora - e.acimaDesde) / MIN) : null,
      });
      novo.tempAlerta = 0;
      novo.acimaDesde = 0;
    }
  } else {
    // Normal e abaixo do limite: zera o cronômetro (ex.: porta aberta que já fechou).
    novo.acimaDesde = 0;
  }

  return { novo, eventos };
}

/**
 * Avalia se um freezer parou de mandar dados (queda de energia, Wi-Fi, travamento).
 * Roda no watchdog periódico.
 */
export function avaliarOffline(estadoBruto, agora, cfg) {
  const e = normalizarEstado(estadoBruto);
  const novo = {};
  const eventos = [];

  if (!e.lastSeen) return { novo, eventos }; // nunca enviou nada ainda

  const semDadosMs = agora - e.lastSeen;
  if (semDadosMs < cfg.offlineMin * MIN) return { novo, eventos };

  const minutosSemDados = Math.round(semDadosMs / MIN);

  if (!e.offlineAlerta) {
    eventos.push({ tipo: 'offline', minutosSemDados, ultimaTemp: e.temp });
    novo.offlineAlerta = 1;
    novo.offlineDesde = e.lastSeen;
    novo.ultimoAvisoOffline = agora;
  } else if (cfg.repetirMin > 0 && agora - e.ultimoAvisoOffline >= cfg.repetirMin * MIN) {
    eventos.push({ tipo: 'offline_persiste', minutosSemDados, ultimaTemp: e.temp });
    novo.ultimoAvisoOffline = agora;
  }

  return { novo, eventos };
}

// -----------------------------------------------------------------------------
// Texto das notificações
// -----------------------------------------------------------------------------
const fmt = (t) => (t === null || t === undefined || !Number.isFinite(Number(t)) ? '--' : `${Number(t).toFixed(1)} °C`);

const duracao = (min) => {
  if (min === null || min === undefined) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
};

/**
 * Transforma um evento em mensagem.
 * "urgente" = deve tocar como alarme (Pushover prioridade de emergência,
 * notificação que exige interação etc.).
 */
export function montarMensagem(evento, { loja, freezer, nomeLoja }) {
  const nomeFreezer = String(freezer).replace(/_/g, ' ').toUpperCase();
  const onde = `${nomeLoja} · ${nomeFreezer}`;
  const tag = `${loja}/${freezer}`; // agrupa notificações do mesmo freezer

  switch (evento.tipo) {
    case 'temp_alta':
      return {
        urgente: true,
        tag,
        titulo: `🚨 TEMPERATURA ALTA — ${nomeLoja}`,
        corpo: `${nomeFreezer} está em ${fmt(evento.temp)} (limite ${fmt(evento.limite)}) há ${duracao(evento.minutosAcima)}. Verifique porta, energia e compressor.`,
      };
    case 'temp_alta_persiste':
      return {
        urgente: true,
        tag,
        titulo: `🚨 AINDA EM ALERTA — ${nomeLoja}`,
        corpo: `${nomeFreezer} continua em ${fmt(evento.temp)} há ${duracao(evento.minutosAcima)}.`,
      };
    case 'temp_normal':
      return {
        urgente: false,
        tag,
        titulo: `✅ Temperatura normalizada — ${nomeLoja}`,
        corpo: `${nomeFreezer} voltou para ${fmt(evento.temp)}${evento.minutosEmAlerta ? ` (ficou ${duracao(evento.minutosEmAlerta)} fora do ideal)` : ''}.`,
      };
    case 'offline':
      return {
        urgente: true,
        tag,
        titulo: `⚡ SEM SINAL — ${nomeLoja}`,
        corpo: `${nomeFreezer} parou de enviar dados há ${duracao(evento.minutosSemDados)}. Possível queda de energia ou de internet na loja. Última leitura: ${fmt(evento.ultimaTemp)}.`,
      };
    case 'offline_persiste':
      return {
        urgente: true,
        tag,
        titulo: `⚡ CONTINUA SEM SINAL — ${nomeLoja}`,
        corpo: `${nomeFreezer} está sem enviar dados há ${duracao(evento.minutosSemDados)}.`,
      };
    case 'online':
      return {
        urgente: false,
        tag,
        titulo: `🔌 Sinal restabelecido — ${nomeLoja}`,
        corpo: `${nomeFreezer} voltou a enviar dados${evento.minutosFora ? ` depois de ${duracao(evento.minutosFora)} fora` : ''}. Confira a temperatura.`,
      };
    case 'sensor_falha':
      return {
        urgente: true,
        tag,
        titulo: `🛠️ FALHA NO SENSOR — ${nomeLoja}`,
        corpo: `${nomeFreezer} está enviando leitura inválida (${evento.valor === null ? 'sem valor' : fmt(evento.valor)}). O monitoramento de temperatura desse freezer está cego até corrigir o sensor.`,
      };
    case 'sensor_ok':
      return {
        urgente: false,
        tag,
        titulo: `🛠️ Sensor normalizado — ${nomeLoja}`,
        corpo: `${nomeFreezer} voltou a ler ${fmt(evento.temp)}.`,
      };
    default:
      return { urgente: false, tag, titulo: `Nevaska — ${onde}`, corpo: evento.tipo };
  }
}
