// Teste de ponta a ponta dos endpoints com banco e Web Push FALSOS (em memória).
// Simula o ESP32 mandando dados, o freezer esquentando, a loja caindo e voltando.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEVICE_KEY = 'chave-teste';
process.env.CRON_SECRET = 'cron-teste';
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';
process.env.TOLERANCIA_MIN = '0'; // alerta imediato para o teste
process.env.OFFLINE_MIN = '3';

const { _definirDbParaTeste, _conversao } = await import('../lib/db.js');
const { _definirWebPushParaTeste } = await import('../lib/notificar.js');
const telemetria = (await import('../api/telemetria.js')).default;
const watchdog = (await import('../api/watchdog.js')).default;
const inscrever = (await import('../api/inscrever.js')).default;
const estadoApi = (await import('../api/estado.js')).default;
const { _resetarCaronaParaTeste } = await import('../lib/watchdog.js');

// ---------- Banco falso: guarda as linhas no MESMO formato do Postgres ----------
// (passa pela conversão real camelCase <-> snake_case de lib/db.js)
function criarDbFalso() {
  const freezers = new Map();     // id -> linha (snake_case, booleanos de verdade)
  const inscricoes = new Map();   // endpoint -> dados
  const travas = new Map();       // nome -> expira em (ms)
  return {
    freezers,
    inscricoes,
    async lerEstado(id) { return _conversao.linhaParaEstado(freezers.get(id)); },
    async salvarEstado(id, parcial) {
      const [loja, freezer] = id.split('/');
      freezers.set(id, { ...(freezers.get(id) || { id, loja, freezer }), ..._conversao.estadoParaLinha(parcial) });
    },
    async listarEstados() {
      return [...freezers.values()].sort((a, b) => a.id.localeCompare(b.id)).map((l) => ({ id: l.id, estado: _conversao.linhaParaEstado(l) }));
    },
    async pegarTrava(nome, ttl) {
      const ate = travas.get(nome);
      if (ate && ate > Date.now()) return false;
      travas.set(nome, Date.now() + ttl * 1000);
      return true;
    },
    async soltarTrava(nome) { travas.delete(nome); },
    async listarInscricoes() { return [...inscricoes.values()]; },
    async salvarInscricao(i) { inscricoes.set(i.endpoint, i); },
    async removerInscricao(e) { inscricoes.delete(e); },
    // atalho dos testes: cria um freezer com estado pronto
    async semear(id, estado) { await this.salvarEstado(id, estado); },
  };
}

let dbFalso;
let pushesEnviados;

beforeEach(() => {
  dbFalso = criarDbFalso();
  _definirDbParaTeste(dbFalso);
  _resetarCaronaParaTeste();
  delete process.env.PAINEL_CHAVE;
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
  assert.equal(r.body.limite, -12); // ESP32 usa este valor no display/LEDs

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
  await dbFalso.semear(id, { lastSeen: Date.now() - 10 * 60_000, temp: -19 });

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
  await dbFalso.semear(caida, { lastSeen: Date.now() - 5 * 60_000, temp: -19 });

  // Bernardino segue enviando → já dispara a checagem de Santa Cruz
  const r = await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_BERNARDINO', freezer: 'freezer_01', temp: -19 } });
  assert.equal(r.body.watchdog, true);
  assert.ok(pushesEnviados.some((p) => /SEM SINAL — Santa Cruz/.test(p.title)));
});

test('inscrição morta (410) é removida automaticamente', async () => {
  await chamar(inscrever, { body: { subscription: insc('viva') } });
  await chamar(inscrever, { body: { subscription: insc('morta') } });
  await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_SC', freezer: 'f9', temp: 99 } });
  const restantes = [...dbFalso.inscricoes.keys()];
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

test('/api/estado devolve os freezers com status calculado', async () => {
  const h = { 'x-chave-dispositivo': 'chave-teste' };
  await chamar(telemetria, { headers: h, body: { loja: 'NEVASKA_SC', freezer: 'freezer_01', temp: -19.5 } });
  await chamar(telemetria, { headers: h, body: { loja: 'NEVASKA_SC', freezer: 'freezer_02', temp: -3 } });
  await chamar(telemetria, { headers: h, body: { loja: 'NEVASKA_BERNARDINO', freezer: 'freezer_01', temp: null } });
  // Um freezer que parou de enviar há 10 min
  const id = 'NEVASKA_BERNARDINO/freezer_02';
  await dbFalso.semear(id, { lastSeen: Date.now() - 10 * 60_000, temp: -18 });

  const r = await chamar(estadoApi, { method: 'GET' });
  assert.equal(r.status, 200);
  const porId = Object.fromEntries(r.body.freezers.map((f) => [f.id, f]));
  assert.equal(porId['NEVASKA_SC/freezer_01'].temp, -19.5);
  assert.equal(porId['NEVASKA_SC/freezer_01'].offline, false);
  assert.equal(porId['NEVASKA_SC/freezer_02'].tempAlerta, true); // TOLERANCIA_MIN=0 no teste
  assert.equal(porId['NEVASKA_BERNARDINO/freezer_01'].sensorFalha, true);
  assert.equal(porId['NEVASKA_BERNARDINO/freezer_02'].offline, true);
  assert.equal(porId['NEVASKA_BERNARDINO/freezer_02'].temp, -18);
});

test('/api/estado com PAINEL_CHAVE exige senha e não usa cache compartilhado', async () => {
  process.env.PAINEL_CHAVE = 'senha-painel';
  let r = await chamar(estadoApi, { method: 'GET' });
  assert.equal(r.status, 401);
  r = await chamar(estadoApi, { method: 'GET', headers: { 'x-chave-painel': 'senha-painel' } });
  assert.equal(r.status, 200);
  delete process.env.PAINEL_CHAVE;
});

test('conversão para o banco grava booleanos de verdade e volta igual', () => {
  const linha = _conversao.estadoParaLinha({ tempAlerta: 1, offlineAlerta: 0, sensorFalha: 1, temp: -5.5, lastSeen: 123, campoInexistente: 'x' });
  assert.deepEqual(linha, { temp_alerta: true, offline_alerta: false, sensor_falha: true, temp: -5.5, last_seen: 123 });
  const volta = _conversao.linhaParaEstado({ ...linha, acima_desde: 0, temp: null });
  assert.deepEqual(volta, { tempAlerta: true, offlineAlerta: false, sensorFalha: true, lastSeen: 123, acimaDesde: 0 });
});

test('linha do freezer guarda loja e freezer separados', async () => {
  await chamar(telemetria, { headers: { 'x-chave-dispositivo': 'chave-teste' }, body: { loja: 'NEVASKA_SC', freezer: 'freezer_07', temp: -19 } });
  const linha = dbFalso.freezers.get('NEVASKA_SC/freezer_07');
  assert.equal(linha.loja, 'NEVASKA_SC');
  assert.equal(linha.freezer, 'freezer_07');
  assert.equal(linha.temp, -19);
  assert.equal(typeof linha.last_seen, 'number');
});
