// =============================================================================
// Conexão com o Upstash Redis (via HTTP — ideal para funções serverless,
// que não conseguem manter conexões TCP abertas entre execuções).
//
// Se você instalou o Upstash pelo Marketplace da Vercel, as variáveis
// KV_REST_API_URL / KV_REST_API_TOKEN já são criadas automaticamente.
// Se criou direto no console do Upstash, use UPSTASH_REDIS_REST_URL / _TOKEN.
// =============================================================================
import { Redis } from '@upstash/redis';

let instancia = null;

export function redis() {
  if (instancia) return instancia;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Redis não configurado: defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN (ou KV_REST_API_URL / KV_REST_API_TOKEN).');
  }
  instancia = new Redis({ url, token });
  return instancia;
}

// Permite injetar um Redis falso nos testes.
export function _definirRedisParaTeste(fake) {
  instancia = fake;
}

// Nomes das chaves num lugar só.
export const CHAVES = {
  freezers: 'nv:freezers',                 // SET com "LOJA/freezer_xx"
  estado: (id) => `nv:f:${id}`,            // HASH com o estado do freezer
  inscricoes: 'nv:push:inscricoes',        // HASH endpoint -> inscrição Web Push (JSON)
  travaWatchdog: 'nv:trava:watchdog',      // trava para não rodar o watchdog em paralelo
};
