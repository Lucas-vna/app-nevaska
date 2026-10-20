// Testes da lógica de alertas. Rode com:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avaliarLeitura, avaliarOffline, montarMensagem } from '../lib/regras.js';

const MIN = 60_000;
const cfg = { toleranciaMin: 5, repetirMin: 30, histerese: 2, offlineMin: 3, sensorMin: -55, sensorMax: 60 };
const LIMITE = -12;

// Simula uma sequência de leituras, aplicando o "novo" ao estado como o Redis faria.
function simular(leituras, estadoInicial = {}) {
  let estado = { ...estadoInicial };
  const todos = [];
  for (const [minuto, temp] of leituras) {
    const { novo, eventos } = avaliarLeitura(estado, temp, minuto * MIN, cfg, LIMITE);
    estado = { ...estado, ...novo };
    todos.push(...eventos.map((e) => ({ minuto, ...e })));
  }
  return { estado, eventos: todos };
}

test('temperatura normal não gera evento', () => {
  const { eventos } = simular([[1, -19], [2, -18.5], [3, -20]]);
  assert.equal(eventos.length, 0);
});

test('porta aberta por pouco tempo NÃO alerta (tolerância)', () => {
  const { eventos } = simular([[1, -19], [2, -9], [3, -8], [4, -15], [5, -18]]);
  assert.equal(eventos.length, 0);
});

test('acima do limite por 5 min alerta UMA vez', () => {
  const { eventos } = simular([[0, -19], [1, -10], [2, -9], [3, -8], [4, -8], [5, -7], [6, -7], [7, -6]]);
  const altas = eventos.filter((e) => e.tipo === 'temp_alta');
  assert.equal(altas.length, 1);
  assert.equal(altas[0].minuto, 6); // começou acima no minuto 1 → 5 min depois
});

test('repete o aviso a cada 30 min enquanto persistir', () => {
  const leituras = [];
  for (let m = 100; m <= 170; m++) leituras.push([m, -5]);
  const { eventos } = simular(leituras);
  assert.deepEqual(eventos.map((e) => [e.tipo, e.minuto]), [
    ['temp_alta', 105],
    ['temp_alta_persiste', 135],
    ['temp_alta_persiste', 165],
  ]);
});

test('histerese: só normaliza 2 °C abaixo do limite', () => {
  const leituras = [];
  for (let m = 1; m <= 7; m++) leituras.push([m, -5]);
  leituras.push([8, -12.5]);  // abaixo do limite, mas dentro da histerese
  leituras.push([9, -13]);    // ainda dentro
  leituras.push([10, -14.5]); // passou da histerese → normaliza
  const { eventos, estado } = simular(leituras);
  assert.deepEqual(eventos.map((e) => e.tipo), ['temp_alta', 'temp_normal']);
  assert.equal(eventos[1].minuto, 10);
  assert.equal(estado.tempAlerta, 0);
});

test('sensor inválido avisa uma vez e preserva a última temperatura boa', () => {
  const { eventos, estado } = simular([[1, -19], [2, NaN], [3, NaN], [4, 85], [5, -18]]);
  assert.deepEqual(eventos.map((e) => e.tipo), ['sensor_falha', 'sensor_ok']);
  assert.equal(estado.temp, -18);
});

test('falha de sensor não zera alerta de temperatura em andamento', () => {
  const leituras = [];
  for (let m = 1; m <= 7; m++) leituras.push([m, -5]);
  leituras.push([8, NaN]);
  const { estado } = simular(leituras);
  assert.equal(estado.tempAlerta, 1);
});

test('offline: alerta após 3 min sem dados e repete a cada 30', () => {
  let estado = { lastSeen: 10 * MIN, temp: -19 };
  const eventos = [];
  for (let m = 11; m <= 80; m++) {
    const r = avaliarOffline(estado, m * MIN, cfg);
    estado = { ...estado, ...r.novo };
    eventos.push(...r.eventos.map((e) => [e.tipo, m]));
  }
  assert.deepEqual(eventos, [['offline', 13], ['offline_persiste', 43], ['offline_persiste', 73]]);
});

test('voltou a enviar depois de offline → evento online', () => {
  const estado = { lastSeen: 10 * MIN, temp: -19, offlineAlerta: 1, offlineDesde: 10 * MIN };
  const { novo, eventos } = avaliarLeitura(estado, -18, 50 * MIN, cfg, LIMITE);
  assert.equal(eventos[0].tipo, 'online');
  assert.equal(eventos[0].minutosFora, 40);
  assert.equal(novo.offlineAlerta, 0);
});

test('freezer que nunca enviou não gera offline', () => {
  const { eventos } = avaliarOffline({}, 999 * MIN, cfg);
  assert.equal(eventos.length, 0);
});

test('estado vindo do Redis como string funciona', () => {
  const estado = { lastSeen: String(10 * MIN), tempAlerta: '1', acimaDesde: String(5 * MIN), ultimoAvisoTemp: String(10 * MIN), temp: '-5' };
  const { eventos } = avaliarLeitura(estado, -20, 11 * MIN, cfg, LIMITE);
  assert.equal(eventos[0].tipo, 'temp_normal');
});

test('mensagens são montadas para todos os tipos', () => {
  const ctx = { loja: 'NEVASKA_SC', freezer: 'freezer_01', nomeLoja: 'Santa Cruz' };
  for (const tipo of ['temp_alta', 'temp_alta_persiste', 'temp_normal', 'offline', 'offline_persiste', 'online', 'sensor_falha', 'sensor_ok']) {
    const m = montarMensagem({ tipo, temp: -5, limite: -12, minutosAcima: 75, minutosSemDados: 4, minutosFora: 12, ultimaTemp: -19, valor: null }, ctx);
    assert.ok(m.titulo.includes('Santa Cruz'), tipo);
    assert.ok(m.corpo.length > 10, tipo);
    assert.equal(m.tag, 'NEVASKA_SC/freezer_01');
  }
  const alta = montarMensagem({ tipo: 'temp_alta', temp: -5, limite: -12, minutosAcima: 75 }, ctx);
  assert.match(alta.corpo, /FREEZER 01 está em -5\.0 °C \(limite -12\.0 °C\) há 1h15/);
  assert.equal(alta.urgente, true);
});
