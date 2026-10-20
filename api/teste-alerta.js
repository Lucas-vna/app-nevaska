// =============================================================================
// GET /api/teste-alerta
// Dispara uma notificação de teste em TODOS os canais e devolve o resultado
// de cada um. Use para validar a instalação nos celulares da equipe.
//
// Header: Authorization: Bearer <CRON_SECRET>
// Opcional: ?urgente=1 para testar o modo alarme (Pushover prioridade 2).
// =============================================================================
import { notificar } from '../lib/notificar.js';
import { adminAutorizado } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!adminAutorizado(req)) return res.status(401).json({ erro: 'Não autorizado' });

  const urgente = req.query?.urgente === '1';
  const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const resultados = await notificar({
    titulo: urgente ? '🚨 TESTE DE ALARME — Nevaska' : '🔔 Teste de notificação — Nevaska',
    corpo: `Se você recebeu isto, os alertas estão funcionando. (${hora})`,
    tag: 'teste',
    urgente,
  });
  return res.status(200).json({ ok: true, resultados });
}
