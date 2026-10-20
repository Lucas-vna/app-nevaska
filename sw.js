// =============================================================================
// Service Worker do Nevaska
//
// Este arquivo é o que recebe o push MESMO COM O APP FECHADO E A TELA BLOQUEADA.
// O sistema operacional (Android/iOS) acorda o service worker quando chega uma
// mensagem do serviço de push do Google/Apple; ele mostra a notificação e dorme.
//
// IMPORTANTE: precisa ser um arquivo real servido na raiz do site (/sw.js).
// Service worker criado via Blob URL (como estava antes) não é aceito pelos
// navegadores, então o push nunca funcionaria.
// =============================================================================

const VERSAO = 'nevaska-sw-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// -----------------------------------------------------------------------------
// Chegou um push do servidor
// -----------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = { title: 'Nevaska', body: event.data ? event.data.text() : 'Novo alerta' };
  }

  const titulo = dados.title || 'Nevaska';
  const opcoes = {
    body: dados.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',          // ícone monocromático da barra de status (Android)
    tag: dados.tag || 'nevaska',            // agrupa avisos do mesmo freezer
    renotify: true,                         // mesmo com a mesma tag, vibra/toca de novo
    requireInteraction: !!dados.urgente,    // alerta fica na tela até alguém tocar
    vibrate: dados.urgente ? [500, 200, 500, 200, 500, 200, 800] : [200, 100, 200],
    timestamp: dados.ts || Date.now(),
    data: { url: dados.url || '/' },
  };

  // No iOS, TODO push precisa virar notificação visível; se não virar,
  // o Safari pode cancelar a inscrição. Por isso sempre chamamos showNotification.
  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

// -----------------------------------------------------------------------------
// Toque na notificação → abre (ou foca) o painel
// -----------------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const janela of janelas) {
        if (janela.url.startsWith(self.location.origin) && 'focus' in janela) return janela.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })()
  );
});

// -----------------------------------------------------------------------------
// O navegador trocou a inscrição sozinho (expirou/rotacionou).
// Refaz a inscrição e avisa o servidor, sem o usuário precisar abrir o app.
// -----------------------------------------------------------------------------
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cfg = await fetch('/api/config').then((r) => r.json());
        if (!cfg.vapidPublicKey) return;
        const nova = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlParaUint8(cfg.vapidPublicKey),
        });
        await fetch('/api/inscrever', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: nova.toJSON() }),
        });
        if (event.oldSubscription) {
          await fetch('/api/inscrever', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
          });
        }
      } catch (err) {
        console.error(`[${VERSAO}] falha ao renovar inscrição`, err);
      }
    })()
  );
});

function base64UrlParaUint8(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(base64);
  return Uint8Array.from([...bruto].map((c) => c.charCodeAt(0)));
}
