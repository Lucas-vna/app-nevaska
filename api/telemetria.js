// =============================================================================
// POST /api/telemetria
// Recebe a leitura do ESP32 (a cada 60 s), guarda para o painel, decide se
// precisa alertar e dispara as notificações. É o "cérebro" do sistema.
//
// Header:  x-chave-dispositivo: <DEVICE_KEY>
// Corpo:   { "loja": "NEVASKA_SC", "freezer": "freezer_01", "temp": -19.4 }
//          (temp = null quando o ESP32 detecta sensor desconectado)
// =============================================================================
import { lerEstado, salvarEstado } from '../lib/db.js';
import { CONFIG, limiteDe, nomeLoja } from '../lib/config.js';
import { avaliarLeitura, montarMensagem } from '../lib/regras.js';
import { notificar } from '../lib/notificar.js';
import { watchdogDeCarona } from '../lib/watchdog.js';
import { dispositivoAutorizado } from '../lib/auth.js';

const ID_VALIDO = /^[A-Za-z0-9_-]{1,40}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST' });
  }
  if (!dispositivoAutorizado(req)) return res.status(401).json({ erro: 'Chave do dispositivo inválida' });

  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch { corpo = {}; }
  }
  const { loja, freezer } = corpo || {};
  if (!ID_VALIDO.test(loja || '') || !ID_VALIDO.test(freezer || '')) {
    return res.status(400).json({ erro: 'loja/freezer inválidos' });
  }

  // null/undefined/"erro" viram NaN → tratado como falha de sensor.
  const temp = typeof corpo.temp === 'number' ? corpo.temp : parseFloat(corpo.temp);

  const id = `${loja}/${freezer}`;

  try {
    const estado = await lerEstado(id);
    const { novo, eventos } = avaliarLeitura(estado, temp, Date.now(), CONFIG, limiteDe(id));

    // Cria a linha do freezer na primeira leitura e atualiza nas seguintes.
    await salvarEstado(id, novo);

    // Notifica ANTES de responder: em serverless, código depois do res.json()
    // pode ser congelado e nunca terminar.
    for (const evento of eventos) {
      await notificar(montarMensagem(evento, { loja, freezer, nomeLoja: nomeLoja(loja) }));
    }

    // Verificação de offline "de carona" (no máximo 1x a cada 50 s).
    let watchdog = null;
    try {
      watchdog = await watchdogDeCarona();
    } catch (err) {
      console.error('[telemetria] watchdog de carona falhou:', err.message);
    }

    return res.status(200).json({ ok: true, eventos: eventos.map((e) => e.tipo), watchdog: watchdog?.executado || false });
  } catch (err) {
    console.error('[telemetria] erro:', err);
    return res.status(500).json({ erro: 'Falha interna' });
  }
}
