// =============================================================================
// GET /api/estado
// Fonte de dados do painel (substitui o MQTT/HiveMQ).
// Devolve a última leitura de cada freezer, já com o status calculado no
// servidor: online/offline, alerta de temperatura e falha de sensor.
//
// Se a variável PAINEL_CHAVE existir, exige o header  x-chave-painel.
// =============================================================================
import { CONFIG, limiteDe } from '../lib/config.js';
import { normalizarEstado } from '../lib/regras.js';
import { lerTodosEstados } from '../lib/watchdog.js';
import { painelAutorizado, painelProtegido } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ erro: 'Use GET' });
  }

  if (painelProtegido()) {
    // Resposta individual: não pode ficar em cache compartilhado.
    res.setHeader('Cache-Control', 'private, no-store');
    if (!painelAutorizado(req)) return res.status(401).json({ erro: 'Senha do painel inválida' });
  } else {
    // Painel aberto: a borda da Vercel guarda a resposta por 10 s.
    // Vários celulares olhando ao mesmo tempo = uma única leitura no banco.
    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=20');
  }

  try {
    const agora = Date.now();
    const lista = await lerTodosEstados();

    const freezers = lista
      .map(({ id, estado }) => {
        const e = normalizarEstado(estado);
        const [loja, freezer] = id.split('/');
        const segundosSemDados = e.lastSeen ? Math.round((agora - e.lastSeen) / 1000) : null;
        return {
          id,
          loja,
          freezer,
          temp: e.temp,
          limite: limiteDe(id),
          ultimaLeitura: e.lastSeen || null,
          segundosSemDados,
          // Calculado aqui, independente do watchdog já ter rodado:
          offline: segundosSemDados === null || segundosSemDados > CONFIG.offlineMin * 60,
          tempAlerta: e.tempAlerta,   // alerta confirmado (passou da tolerância)
          sensorFalha: e.sensorFalha,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return res.status(200).json({ agora, offlineMin: CONFIG.offlineMin, freezers });
  } catch (err) {
    console.error('[estado] erro:', err);
    return res.status(500).json({ erro: 'Falha interna' });
  }
}
