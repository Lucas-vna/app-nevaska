// =============================================================================
// Watchdog: procura freezers que pararam de mandar dados.
//
// É chamado de DOIS jeitos (redundância proposital):
//   a) Por um agendador a cada 1 minuto  → /api/watchdog
//   b) "De carona" em cada telemetria recebida de qualquer freezer.
//      Se a loja de Santa Cruz cair, os freezers de Bernardino continuam
//      enviando e isso já dispara a verificação, mesmo que o agendador atrase.
//
// A trava no Redis garante que só uma execução roda por vez.
// =============================================================================
import { redis, CHAVES } from './redis.js';
import { CONFIG, nomeLoja } from './config.js';
import { avaliarOffline, montarMensagem } from './regras.js';
import { notificar } from './notificar.js';

export async function executarWatchdog({ intervaloMinimoS = 0 } = {}) {
  const r = redis();

  // SET NX com expiração: só passa quem pegar a trava.
  // intervaloMinimoS > 0 é usado na execução "de carona" para não rodar em toda telemetria.
  const ttl = Math.max(intervaloMinimoS, 25);
  const pegouTrava = await r.set(CHAVES.travaWatchdog, String(Date.now()), { nx: true, ex: ttl });
  if (!pegouTrava) return { executado: false, motivo: 'outra execução recente' };

  const agora = Date.now();
  const ids = (await r.smembers(CHAVES.freezers)) || [];
  const relatorio = [];

  for (const id of ids) {
    const estado = (await r.hgetall(CHAVES.estado(id))) || {};
    const { novo, eventos } = avaliarOffline(estado, agora, CONFIG);
    if (Object.keys(novo).length) await r.hset(CHAVES.estado(id), novo);

    const [loja, freezer] = id.split('/');
    for (const evento of eventos) {
      await notificar(montarMensagem(evento, { loja, freezer, nomeLoja: nomeLoja(loja) }));
      relatorio.push({ id, evento: evento.tipo });
    }
  }

  // Na execução agendada, solta a trava logo para não bloquear a próxima.
  if (!intervaloMinimoS) await r.del(CHAVES.travaWatchdog);

  return { executado: true, freezers: ids.length, eventos: relatorio };
}
