// =============================================================================
// GET /api/config
// Entrega ao painel a chave PÚBLICA do VAPID, os nomes das lojas e os limites
// de temperatura (a mesma regra usada pelos alertas).
// =============================================================================
import { CONFIG } from '../lib/config.js';
import { painelProtegido } from '../lib/auth.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    limiteTemp: CONFIG.limiteTemp,
    offlineMin: CONFIG.offlineMin,
    nomesLojas: CONFIG.nomesLojas,
    painelProtegido: painelProtegido(),
  });
}
