// Comparação de segredos em tempo constante (evita ataque de timing).
import { timingSafeEqual } from 'node:crypto';

export function segredoConfere(recebido, esperado) {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ESP32 → header "x-chave-dispositivo: <DEVICE_KEY>"
export function dispositivoAutorizado(req) {
  return segredoConfere(req.headers['x-chave-dispositivo'], process.env.DEVICE_KEY);
}

// Agendador / testes administrativos → "Authorization: Bearer <CRON_SECRET>"
// (é exatamente o formato que o Vercel Cron envia sozinho quando CRON_SECRET existe).
// Também aceita ?chave=<CRON_SECRET> para agendadores que não deixam configurar header.
export function adminAutorizado(req) {
  const header = req.headers.authorization || '';
  const viaHeader = header.startsWith('Bearer ') ? header.slice(7) : '';
  const viaQuery = req.query?.chave;
  return segredoConfere(viaHeader || viaQuery, process.env.CRON_SECRET);
}

// Painel → header "x-chave-painel: <PAINEL_CHAVE>".
// OPCIONAL: se a variável PAINEL_CHAVE não existir, o painel é aberto
// (qualquer pessoa com o link vê as temperaturas, como era com o MQTT).
export function painelProtegido() {
  return !!process.env.PAINEL_CHAVE;
}
export function painelAutorizado(req) {
  if (!painelProtegido()) return true;
  return segredoConfere(req.headers['x-chave-painel'], process.env.PAINEL_CHAVE);
}
