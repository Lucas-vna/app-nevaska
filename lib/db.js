// =============================================================================
// Camada de banco de dados (Supabase / Postgres).
//
// Todo o resto do sistema só conversa com as funções deste arquivo. Se um dia
// trocar de banco de novo, só este arquivo muda.
//
// Variáveis de ambiente (Vercel):
//   SUPABASE_URL                 → Project URL (Settings → API)
//   SUPABASE_SERVICE_ROLE_KEY    → chave SECRETA (service_role / secret). Nunca no front!
// =============================================================================
import { createClient } from '@supabase/supabase-js';

let cliente = null;
let dbDeTeste = null;

function sb() {
  if (cliente) return cliente;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !chave) {
    throw new Error('Supabase não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na Vercel.');
  }
  cliente = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
  return cliente;
}

function checar({ error }, contexto) {
  if (error) throw new Error(`[db] ${contexto}: ${error.message}`);
}

// ----- conversão entre o formato do banco (snake_case) e o do código (camelCase)
const MAPA = {
  temp: 'temp',
  lastSeen: 'last_seen',
  acimaDesde: 'acima_desde',
  tempAlerta: 'temp_alerta',
  ultimoAvisoTemp: 'ultimo_aviso_temp',
  offlineAlerta: 'offline_alerta',
  offlineDesde: 'offline_desde',
  ultimoAvisoOffline: 'ultimo_aviso_offline',
  sensorFalha: 'sensor_falha',
};
const BOOLEANOS = new Set(['tempAlerta', 'offlineAlerta', 'sensorFalha']);

function linhaParaEstado(linha) {
  if (!linha) return {};
  const estado = {};
  for (const [campo, coluna] of Object.entries(MAPA)) {
    if (linha[coluna] !== undefined && linha[coluna] !== null) estado[campo] = linha[coluna];
  }
  return estado;
}

function estadoParaLinha(parcial) {
  const linha = {};
  for (const [campo, valor] of Object.entries(parcial)) {
    const coluna = MAPA[campo];
    if (!coluna) continue;
    linha[coluna] = BOOLEANOS.has(campo) ? Boolean(Number(valor)) : valor;
  }
  return linha;
}

// =============================================================================
// Freezers
// =============================================================================
export async function lerEstado(id) {
  if (dbDeTeste) return dbDeTeste.lerEstado(id);
  const r = await sb().from('freezers').select('*').eq('id', id).maybeSingle();
  checar(r, 'lerEstado');
  return linhaParaEstado(r.data);
}

// Grava só os campos informados (os outros ficam como estão).
export async function salvarEstado(id, parcial) {
  if (dbDeTeste) return dbDeTeste.salvarEstado(id, parcial);
  const [loja, freezer] = id.split('/');
  const linha = { id, loja, freezer, ...estadoParaLinha(parcial), atualizado_em: new Date().toISOString() };
  const r = await sb().from('freezers').upsert(linha, { onConflict: 'id' });
  checar(r, 'salvarEstado');
}

export async function listarEstados() {
  if (dbDeTeste) return dbDeTeste.listarEstados();
  const r = await sb().from('freezers').select('*').order('id');
  checar(r, 'listarEstados');
  return (r.data || []).map((linha) => ({ id: linha.id, estado: linhaParaEstado(linha) }));
}

// =============================================================================
// Trava do watchdog
// =============================================================================
export async function pegarTrava(nome, ttlSegundos) {
  if (dbDeTeste) return dbDeTeste.pegarTrava(nome, ttlSegundos);
  const r = await sb().rpc('pegar_trava', { p_nome: nome, p_ttl_ms: ttlSegundos * 1000 });
  checar(r, 'pegarTrava');
  return r.data === true;
}

export async function soltarTrava(nome) {
  if (dbDeTeste) return dbDeTeste.soltarTrava(nome);
  const r = await sb().from('travas').delete().eq('nome', nome);
  checar(r, 'soltarTrava');
}

// =============================================================================
// Inscrições de Web Push
// =============================================================================
export async function listarInscricoes() {
  if (dbDeTeste) return dbDeTeste.listarInscricoes();
  const r = await sb().from('inscricoes_push').select('dados');
  checar(r, 'listarInscricoes');
  return (r.data || []).map((l) => l.dados);
}

export async function salvarInscricao(inscricao) {
  if (dbDeTeste) return dbDeTeste.salvarInscricao(inscricao);
  const r = await sb()
    .from('inscricoes_push')
    .upsert({ endpoint: inscricao.endpoint, dados: inscricao }, { onConflict: 'endpoint' });
  checar(r, 'salvarInscricao');
}

export async function removerInscricao(endpoint) {
  if (dbDeTeste) return dbDeTeste.removerInscricao(endpoint);
  const r = await sb().from('inscricoes_push').delete().eq('endpoint', endpoint);
  checar(r, 'removerInscricao');
}

// Permite trocar o banco por um falso (em memória) nos testes.
export function _definirDbParaTeste(fake) {
  dbDeTeste = fake;
}

// Exportado só para os testes conferirem a conversão.
export const _conversao = { linhaParaEstado, estadoParaLinha };
