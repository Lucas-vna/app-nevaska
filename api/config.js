// =============================================================================
// GET /api/config
// Entrega ao front a chave PÚBLICA do VAPID e os limites de temperatura,
// para o painel pintar os cards com a mesma regra usada pelos alertas.
// =============================================================================
import { CONFIG } from '../lib/config.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    limiteTemp: CONFIG.limiteTemp,
    limitesPorFreezer: CONFIG.limitesPorFreezer,
    offlineMin: CONFIG.offlineMin,
    nomesLojas: CONFIG.nomesLojas,
  });
}
