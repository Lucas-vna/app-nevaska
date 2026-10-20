// =============================================================================
// Watchdog: procura freezers que pararam de mandar dados.
//
// É chamado de DOIS jeitos (redundância proposital):
//   a) Por um agendador a cada 1 minuto  → /api/watchdog
//   b) "De carona" nas telemetrias recebidas de qualquer freezer.
//      Se a loja de Santa Cruz cair, os freezers de Bernardino continuam
//      enviando e isso já dispara a verificação, mesmo que o agendador atrase.
//
// A trava no banco garante que só uma execução roda por vez.
// =============================================================================
import { listarEstados, salvarEstado, pegarTrava, soltarTrava } from './db.js';
import { CONFIG, nomeLoja } from './config.js';
import { avaliarOffline, montarMensagem } from './regras.js';
import { notificar } from './notificar.js';

// Lê o estado de todos os freezers (usado pelo watchdog e pelo painel).
export async function lerTodosEstados() {
  return listarEstados();
}

const TRAVA = 'watchdog';

export async function executarWatchdog({ intervaloMinimoS = 0 } = {}) {
  // Só passa quem pegar a trava (ela expira sozinha depois de "ttl" segundos).
  const ttl = Math.max(intervaloMinimoS, 25);
  const pegouTrava = await pegarTrava(TRAVA, ttl);
  if (!pegouTrava) return { executado: false, motivo: 'outra execução recente' };

  const agora = Date.now();
  const lista = await lerTodosEstados();
  const relatorio = [];

  for (const { id, estado } of lista) {
    const { novo, eventos } = avaliarOffline(estado, agora, CONFIG);
    if (Object.keys(novo).length) await salvarEstado(id, novo);

    const [loja, freezer] = id.split('/');
    for (const evento of eventos) {
      await notificar(montarMensagem(evento, { loja, freezer, nomeLoja: nomeLoja(loja) }));
      relatorio.push({ id, evento: evento.tipo });
    }
  }

  // Na execução agendada, solta a trava logo para não bloquear a próxima.
  if (!intervaloMinimoS) await soltarTrava(TRAVA);

  return { executado: true, freezers: lista.length, eventos: relatorio };
}

// -----------------------------------------------------------------------------
// Execução "de carona". O controle em memória evita consultar o banco em toda
// telemetria: enquanto a função estiver "quente" na Vercel, ela só tenta de
// novo depois de 50 s.
// -----------------------------------------------------------------------------
const INTERVALO_CARONA_MS = 50_000;
let ultimaCaronaMs = 0;

export async function watchdogDeCarona() {
  if (Date.now() - ultimaCaronaMs < INTERVALO_CARONA_MS) return { executado: false, motivo: 'intervalo local' };
  ultimaCaronaMs = Date.now();
  return executarWatchdog({ intervaloMinimoS: INTERVALO_CARONA_MS / 1000 });
}

export function _resetarCaronaParaTeste() {
  ultimaCaronaMs = 0;
}
