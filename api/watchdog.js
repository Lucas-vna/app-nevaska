// =============================================================================
// GET /api/watchdog
// Chamado a cada 1 minuto por um agendador externo (cron-job.org) ou pelo
// Vercel Cron (plano Pro). Detecta freezer sem sinal = queda de energia/internet.
//
// Header: Authorization: Bearer <CRON_SECRET>
// =============================================================================
import { executarWatchdog } from '../lib/watchdog.js';
import { adminAutorizado } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!adminAutorizado(req)) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    const resultado = await executarWatchdog();
    return res.status(200).json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[watchdog] erro:', err);
    return res.status(500).json({ erro: err.message });
  }
}
