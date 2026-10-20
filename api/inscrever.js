// =============================================================================
// /api/inscrever
//   POST   { subscription }  → salva o celular para receber Web Push
//                              e manda uma notificação de confirmação SÓ pra ele
//   DELETE { endpoint }      → remove o celular
// =============================================================================
import { redis, CHAVES } from '../lib/redis.js';
import { enviarWebPush } from '../lib/notificar.js';

function inscricaoValida(s) {
  return (
    s &&
    typeof s.endpoint === 'string' &&
    s.endpoint.startsWith('https://') &&
    s.endpoint.length < 1000 &&
    s.keys &&
    typeof s.keys.p256dh === 'string' &&
    typeof s.keys.auth === 'string'
  );
}

export default async function handler(req, res) {
  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch { corpo = {}; }
  }

  try {
    if (req.method === 'POST') {
      const insc = corpo?.subscription;
      if (!inscricaoValida(insc)) return res.status(400).json({ erro: 'Inscrição inválida' });

      const limpa = { endpoint: insc.endpoint, expirationTime: insc.expirationTime ?? null, keys: { p256dh: insc.keys.p256dh, auth: insc.keys.auth } };
      await redis().hset(CHAVES.inscricoes, { [limpa.endpoint]: JSON.stringify(limpa) });

      // Confirmação ponta a ponta: se essa notificação chegar, o caminho todo funciona.
      if (corpo?.confirmar) {
        await enviarWebPush(
          { titulo: '✅ Alertas Nevaska ativados', corpo: 'Este celular vai receber os alertas dos freezers, mesmo com a tela bloqueada.', tag: 'confirmacao', urgente: false },
          [limpa]
        );
      }
      return res.status(201).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const endpoint = corpo?.endpoint;
      if (!endpoint) return res.status(400).json({ erro: 'endpoint obrigatório' });
      await redis().hdel(CHAVES.inscricoes, endpoint);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (err) {
    console.error('[inscrever] erro:', err);
    return res.status(500).json({ erro: 'Falha interna' });
  }
}
