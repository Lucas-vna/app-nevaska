// =============================================================================
// Envio das notificações por TODOS os canais configurados, em paralelo.
//
//  1. Web Push (VAPID)  → notificação nativa no PWA (Android e iPhone)
//  2. Telegram          → canal redundante, chega mesmo se o push falhar
//  3. Pushover          → OPCIONAL, alarme "crítico" que repete até alguém confirmar
//
// Um canal falhar nunca impede os outros: cada um tem seu try/catch.
// Canal sem variável de ambiente configurada é simplesmente ignorado.
// =============================================================================
import webpushPadrao from 'web-push';
import { redis, CHAVES } from './redis.js';
import { CONFIG } from './config.js';

let webpush = webpushPadrao;
let vapidConfigurado = false;

export function _definirWebPushParaTeste(fake) {
  webpush = fake;
  vapidConfigurado = false;
}

function configurarVapid() {
  if (vapidConfigurado) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:alertas@nevaska.com.br', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigurado = true;
  return true;
}

const lerInscricao = (valor) => (typeof valor === 'string' ? JSON.parse(valor) : valor);

// -----------------------------------------------------------------------------
// 1) Web Push
// -----------------------------------------------------------------------------
export async function enviarWebPush(msg, inscricoesEspecificas = null) {
  if (!configurarVapid()) return { canal: 'webpush', ignorado: 'VAPID não configurado' };

  let inscricoes = inscricoesEspecificas;
  if (!inscricoes) {
    const todas = (await redis().hgetall(CHAVES.inscricoes)) || {};
    inscricoes = Object.values(todas).map(lerInscricao);
  }
  if (!inscricoes.length) return { canal: 'webpush', enviados: 0, aviso: 'nenhum celular inscrito' };

  const payload = JSON.stringify({
    title: msg.titulo,
    body: msg.corpo,
    tag: msg.tag,
    urgente: !!msg.urgente,
    url: CONFIG.urlApp,
    ts: Date.now(),
  });

  const opcoes = {
    // urgency "high" é o que faz o Android entregar mesmo em modo soneca (Doze)
    // e com a tela bloqueada. O iOS também respeita a prioridade alta.
    urgency: msg.urgente ? 'high' : 'normal',
    // Se o celular estiver sem internet, o serviço de push (Google/Apple) guarda
    // a mensagem por até 12 h e entrega quando ele voltar.
    TTL: 12 * 60 * 60,
  };

  let enviados = 0;
  let removidos = 0;
  const erros = [];

  await Promise.all(
    inscricoes.map(async (insc) => {
      try {
        await webpush.sendNotification(insc, payload, opcoes);
        enviados++;
      } catch (err) {
        // 404/410 = inscrição morreu (app desinstalado, permissão revogada). Limpa.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          removidos++;
          try {
            await redis().hdel(CHAVES.inscricoes, insc.endpoint);
          } catch {}
        } else {
          erros.push(`${err?.statusCode || ''} ${err?.body || err?.message || err}`.trim());
        }
      }
    })
  );

  return { canal: 'webpush', enviados, removidos, erros };
}

// -----------------------------------------------------------------------------
// 2) Telegram
// -----------------------------------------------------------------------------
const escaparHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function enviarTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!token || !chats.length) return { canal: 'telegram', ignorado: 'não configurado' };

  const texto = `<b>${escaparHtml(msg.titulo)}</b>\n${escaparHtml(msg.corpo)}`;
  const resultados = await Promise.all(
    chats.map(async (chat_id) => {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id,
            text: texto,
            parse_mode: 'HTML',
            disable_notification: !msg.urgente, // mensagens de "normalizou" chegam sem som
          }),
        });
        return r.ok ? null : `${chat_id}: HTTP ${r.status} ${await r.text()}`;
      } catch (err) {
        return `${chat_id}: ${err.message}`;
      }
    })
  );
  const erros = resultados.filter(Boolean);
  return { canal: 'telegram', enviados: chats.length - erros.length, erros };
}

// -----------------------------------------------------------------------------
// 3) Pushover (opcional)
// -----------------------------------------------------------------------------
export async function enviarPushover(msg) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY; // pode ser a chave de um GRUPO de usuários
  if (!token || !user) return { canal: 'pushover', ignorado: 'não configurado' };

  const corpo = new URLSearchParams({
    token,
    user,
    title: msg.titulo,
    message: msg.corpo,
    url: CONFIG.urlApp.startsWith('http') ? CONFIG.urlApp : '',
  });

  if (msg.urgente) {
    // Prioridade 2 = EMERGÊNCIA: toca alarme, ignora horário de silêncio
    // e repete a cada `retry` segundos até alguém tocar em "Confirmar".
    corpo.set('priority', '2');
    corpo.set('retry', String(process.env.PUSHOVER_RETRY_S || 60));
    corpo.set('expire', String(process.env.PUSHOVER_EXPIRE_S || 3600));
    corpo.set('sound', process.env.PUSHOVER_SOM || 'siren');
  } else {
    corpo.set('priority', '0');
  }

  try {
    const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: corpo });
    return r.ok ? { canal: 'pushover', enviados: 1 } : { canal: 'pushover', erros: [`HTTP ${r.status} ${await r.text()}`] };
  } catch (err) {
    return { canal: 'pushover', erros: [err.message] };
  }
}

// -----------------------------------------------------------------------------
// Dispara em todos os canais
// -----------------------------------------------------------------------------
export async function notificar(msg) {
  const resultados = await Promise.all([
    enviarWebPush(msg).catch((e) => ({ canal: 'webpush', erros: [e.message] })),
    enviarTelegram(msg).catch((e) => ({ canal: 'telegram', erros: [e.message] })),
    enviarPushover(msg).catch((e) => ({ canal: 'pushover', erros: [e.message] })),
  ]);

  // Log aparece em Vercel → Logs. Útil para auditar se o alerta saiu.
  console.log('[notificar]', msg.titulo, JSON.stringify(resultados));

  const algumEntregue = resultados.some((r) => r.enviados > 0);
  if (!algumEntregue) console.error('[notificar] NENHUM canal entregou a mensagem!', msg.titulo);

  return resultados;
}
