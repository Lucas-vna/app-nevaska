// Teste de ponta a ponta dos endpoints com Redis e Web Push FALSOS (em memória).
// Simula o ESP32 mandando dados, o freezer esquentando, a loja caindo e voltando.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEVICE_KEY = 'chave-teste';
process.env.CRON_SECRET = 'cron-teste';
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';
process.env.TOLERANCIA_MIN = '0'; // alerta imediato para o teste
process.env.OFFLINE_MIN = '3';

const { _definirRedisParaTeste, CHAVES } = await import('../lib/redis.js');
const { _definirWebPushParaTeste } = await import('../lib/notificar.js');
const telemetria = (await import('../api/telemetria.js')).default;
const watchdog = (await import('../api/watchdog.js')).default;
const inscrever = (await import('../api/inscrever.js')).default;

// ---------- Redis falso (subconjunto usado pelo projeto) ----------
function criarRedisFalso() {
  const kv = new Map();
  const travas = new Map();
  return {
    kv,
    async hgetall(k) { const h = kv.get(k); return h ? { ...h } : null; },
    async hset(k, obj) { kv.set(k, { ...(kv.get(k) || {}), ...obj }); return 1; },
    async hdel(k, f) { const h = kv.get(k); if (h) delete h[f]; return 1; },
    async sadd(k, m) { const s = kv.get(k) || new Set(); s.add(m); kv.set(k, s); return 1; },
    async smembers(k) { return [...(kv.get(k) || [])]; },
    async set(k, v, { nx, ex } = {}) {
      const atual = travas.get(k);
      if (nx && atual && atual > Date.now()) return null;
      travas.set(k, Date.now() + ex * 1000);
      return 'OK';
    },
    async del(k) { travas.delete(k); return 1; },
  };
}

let redisFalso;
let pushesEnviados;

beforeEach(() => {
  redisFalso = criarRedisFalso();
  _definirRedisParaTeste(redisFalso);
  pushesEnviados = [];
  _definirWebPushParaTeste({
    setVapidDetails() {},
    async sendNotification(insc, payload, opcoes) {
      if (insc.endpoint.includes('morta')) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
      pushesEnviados.push({ endpoint: insc.endpoint, ...JSON.parse(payload), opcoes });
    },
  });
});

function chamar(handler, { method = 'POST', headers = {}, body, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
    };
    Promise.resolve(handler({ method, headers, body, query }, res));
  });
}

const insc = (nome) => ({ endpoint: `https://push.exemplo/${nome}`, keys: { p256dh: 'x', auth: 'y' } });

test('fluxo completo: inscrição, alerta de temperatura, normalização', async () => {
  let r = await chamar(inscrever, { body: { subscription: insc('celular-1'), confirmar: true } });
  assert.equal(r.status, 201);
  assert.equal(pushesEnviados.length, 1); // push de confirmação
  assert.match(pushesEnviados[0].title, /ativados/);

  // Sem chave → 401
  r = await chamar(telemetria, { body: { loja: 'NEVASKA_SC', freezer: 'freezer_01', temp: -19 } });
  assert.equal(r.status, 401);

  const h = { 'x-chave-dispositivo': 'chave-teste' };
  r = await chamar(telemetria, { headers: h, body: { loja: 'NEVASKA_SC', freezer: 'freezer_01', temp: -19 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.eventos, []);

  r = await chamar(telemetria, { headers: h, body: { loja: 'NEVASKA_SC', freezer: 'freezer_01', temp: -4 } });
  assert.deepEqual(r.body.eventos, ['temp_alta']);
  const alerta = pushesEnviados.at(-1);
  assert.match(alerta.title, /TEMPERATURA ALTA — Santa Cruz/);
  assert.equal(alerta.opcoes.urgency, 'high');
  assert.equal(alerta.urgente, true);

  r = await chamar(telemetria, { headers: h, body: { loja: 'NEVASKA_SC', freezer: 'freezer_01', temp: -20 } });
  assert.deepEqual(r.body.eventos, ['temp_normal']);
});

test('sensor null vira falha de sensor', async () => {
  await chamar(inscrever, { body: { subscription: insc('c1') } });
  const r = await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_SC', freezer: 'freezer_02', temp: null } });
  assert.deepEqual(r.body.eventos, ['sensor_falha']);
  assert.match(pushesEnviados.at(-1).title, /FALHA NO SENSOR/);
});

test('watchdog detecta queda de energia e telemetria detecta retorno', async () => {
  await chamar(inscrever, { body: { subscription: insc('c1') } });
  // Freezer que mandou dado pela última vez há 10 minutos
  const id = 'NEVASKA_BERNARDINO/freezer_03';
  await redisFalso.sadd(CHAVES.freezers, id);
  await redisFalso.hset(CHAVES.estado(id), { lastSeen: Date.now() - 10 * 60_000, temp: -19 });

  let r = await chamar(watchdog, { method: 'GET' });
  assert.equal(r.status, 401);

  r = await chamar(watchdog, { method: 'GET', headers: { authorization: 'Bearer cron-teste' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.eventos, [{ id, evento: 'offline' }]);
  assert.match(pushesEnviados.at(-1).title, /SEM SINAL — Bernardino/);

  // Segunda execução logo depois não repete
  r = await chamar(watchdog, { method: 'GET', headers: { authorization: 'Bearer cron-teste' } });
  assert.deepEqual(r.body.eventos, []);

  // Energia voltou: ESP32 manda telemetria
  r = await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_BERNARDINO', freezer: 'freezer_03', temp: -17 } });
  assert.deepEqual(r.body.eventos, ['online']);
  assert.match(pushesEnviados.at(-1).title, /Sinal restabelecido/);
});

test('watchdog "de carona" na telemetria de outra loja', async () => {
  await chamar(inscrever, { body: { subscription: insc('c1') } });
  const caida = 'NEVASKA_SC/freezer_01';
  await redisFalso.sadd(CHAVES.freezers, caida);
  await redisFalso.hset(CHAVES.estado(caida), { lastSeen: Date.now() - 5 * 60_000, temp: -19 });

  // Bernardino segue enviando → já dispara a checagem de Santa Cruz
  const r = await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_BERNARDINO', freezer: 'freezer_01', temp: -19 } });
  assert.equal(r.body.watchdog, true);
  assert.ok(pushesEnviados.some((p) => /SEM SINAL — Santa Cruz/.test(p.title)));
});

test('inscrição morta (410) é removida automaticamente', async () => {
  await chamar(inscrever, { body: { subscription: insc('viva') } });
  await chamar(inscrever, { body: { subscription: insc('morta') } });
  await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_SC', freezer: 'f9', temp: 99 } });
  const restantes = Object.keys(redisFalso.kv.get(CHAVES.inscricoes));
  assert.deepEqual(restantes, ['https://push.exemplo/viva']);
});

test('payload inválido é rejeitado', async () => {
  const h = { 'x-chave-dispositivo': 'chave-teste' };
  let r = await chamar(telemetria, { headers: h, body: { loja: '../x', freezer: 'f', temp: 1 } });
  assert.equal(r.status, 400);
  r = await chamar(telemetria, { method: 'GET', headers: h });
  assert.equal(r.status, 405);
  r = await chamar(inscrever, { body: { subscription: { endpoint: 'http://inseguro' } } });
  assert.equal(r.status, 400);
});
