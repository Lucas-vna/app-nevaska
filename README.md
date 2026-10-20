# Nevaska — Alertas de freezer em segundo plano

Este pacote resolve o problema dos alertas que não chegam com o celular bloqueado. A ideia central é simples: **quem decide se tem alerta deixa de ser o celular e passa a ser o servidor.** O celular só recebe o aviso pronto, pelo mesmo canal que o WhatsApp e o banco usam (o serviço de push do Google e da Apple), que funciona com a tela apagada e o app fechado.

## Como fica a arquitetura

```
                ┌──────────── MQTT (10 s) ─────────────►  HiveMQ  ──WebSocket──►  Painel (tempo real)
 ESP32 + NTC ───┤                                      (Last Will "offline")
                └──── HTTPS POST (60 s) ──►  Vercel /api/telemetria
                                                   │  regras: tolerância, histerese, repetição
                                                   │  estado salvo no Upstash Redis
                                                   ▼
                    cron 1 min ──► /api/watchdog ──► notificar() ──┬──► Web Push (Android + iPhone PWA)
                    (+ "carona" em cada telemetria)                ├──► Telegram (grupo da equipe)
                                                                   └──► Pushover (opcional, alarme crítico)
```

- **MQTT continua igual** para o painel ao vivo. Ganhou o Last Will (o próprio broker publica `offline` se o ESP32 sumir).
- **Novo:** o ESP32 manda a leitura a cada 60 s para a Vercel. Esse envio é o "batimento cardíaco" do sistema.
- **Queda de energia** é detectada pela ausência desse batimento: se a Vercel não recebe nada de um freezer por 3 minutos, dispara o alerta. Isso pega queda de luz, internet da loja fora e ESP32 travado, que são situações em que o ESP32 não teria como avisar sozinho.
- O painel não gera mais notificação local, para não duplicar com o push do servidor.

## Estrutura dos arquivos

```
index.html               painel (substitui o atual)
sw.js                    service worker que recebe o push com o app fechado
manifest.json            manifest real do PWA (necessário para instalar no iPhone)
icons/                   ícones do app e da notificação (pode trocar pelos da marca)
api/telemetria.js        recebe a leitura do ESP32 e decide os alertas
api/watchdog.js          detecta freezer sem sinal (queda de energia/internet)
api/inscrever.js         cadastra/remove o celular para receber push
api/config.js            entrega a chave pública VAPID e os limites ao painel
api/teste-alerta.js      dispara uma notificação de teste em todos os canais
lib/                     regras, envio de notificações, Redis, autenticação
tests/                   testes automáticos (npm test)
firmware/                sketch do ESP32
vercel.json              cabeçalhos do sw.js e do manifest
```

## Passo a passo de implantação

### 1. Copiar para o repositório

Coloque todos os arquivos na raiz do repositório que a Vercel já publica (substituindo o `index.html`). Como agora existe `package.json`, a Vercel instala as dependências sozinha no deploy.

Para rodar os testes localmente: `npm install` e depois `npm test`.

### 2. Criar o banco (Upstash Redis)

Na Vercel: **Storage → Marketplace → Upstash (Redis) → Create → conectar ao projeto**. As variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` são criadas automaticamente. O plano gratuito sobra para esse volume.

Se preferir criar direto em upstash.com, copie a REST URL e o token para `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.

### 3. Gerar as chaves do Web Push (VAPID)

No computador, dentro da pasta do projeto:

```bash
npx web-push generate-vapid-keys
```

Copie a *Public Key* para `VAPID_PUBLIC_KEY` e a *Private Key* para `VAPID_PRIVATE_KEY`. Em `VAPID_SUBJECT` coloque um contato, por exemplo `mailto:ti@nevaska.com.br`.

> Gere uma vez só. Se trocar as chaves depois, todos os celulares precisam ativar os alertas de novo.

### 4. Criar os segredos

Gere dois valores aleatórios (pode ser `openssl rand -hex 32` ou um gerador de senha):

- `DEVICE_KEY` → vai no firmware de todos os ESP32 (autentica a telemetria).
- `CRON_SECRET` → autentica o agendador e o endpoint de teste.

### 5. Configurar o Telegram (canal redundante)

1. No Telegram, fale com **@BotFather**, envie `/newbot` e siga as instruções. Guarde o token em `TELEGRAM_BOT_TOKEN`.
2. Crie um grupo (ex.: "Alertas Nevaska"), adicione o bot e as pessoas responsáveis.
3. No grupo, envie `/start@NomeDoSeuBot`.
4. Abra no navegador `https://api.telegram.org/bot<TOKEN>/getUpdates` e procure `"chat":{"id":-100...`. Esse número (com o sinal de menos) vai em `TELEGRAM_CHAT_IDS`. Pode colocar mais de um, separados por vírgula.
5. Peça para cada pessoa abrir o grupo, tocar no nome dele e garantir que as notificações estão ativas (de preferência com um som próprio, para diferenciar dos outros grupos).

### 6. Agendar o watchdog (detecção de queda de energia)

O `/api/watchdog` precisa ser chamado a cada 1 minuto. Duas opções:

**Plano Hobby (gratuito) da Vercel** — o Vercel Cron no Hobby só roda uma vez por dia, então use um agendador externo gratuito, como o cron-job.org:
- URL: `https://SEU-PROJETO.vercel.app/api/watchdog`
- Frequência: a cada 1 minuto
- Header: `Authorization: Bearer <CRON_SECRET>` (se o serviço não permitir header, use a URL `.../api/watchdog?chave=<CRON_SECRET>`)

**Plano Pro da Vercel** — adicione ao `vercel.json`:

```json
"crons": [ { "path": "/api/watchdog", "schedule": "* * * * *" } ]
```

A Vercel envia o `CRON_SECRET` sozinha no header. Não coloque esse bloco no plano Hobby: o deploy falha.

> Vale lembrar que o plano Hobby da Vercel é voltado para uso pessoal; como isso é um sistema de cliente em produção, o Pro é o caminho mais correto contratualmente, e ainda resolve o agendamento.

Mesmo que o agendador atrase, cada telemetria recebida de qualquer freezer também roda a verificação "de carona" (no máximo uma vez a cada 50 s). Se a loja de Santa Cruz cair inteira, os freezers de Bernardino continuam enviando e o alerta sai do mesmo jeito.

### 7. (Opcional) Pushover para alarme crítico

Para quem precisa ser **acordado** (dono, gerente de plantão), o Pushover tem prioridade de emergência: toca uma sirene, fura o modo silencioso e repete a cada minuto até a pessoa tocar em "Confirmar". Cada pessoa instala o app (licença única por plataforma, após 30 dias de teste). Crie uma aplicação em pushover.net, um *Delivery Group* com as pessoas e preencha `PUSHOVER_APP_TOKEN` e `PUSHOVER_USER_KEY` (a chave do grupo). Se não preencher, o canal fica desligado.

### 8. HiveMQ: separar as credenciais

O `index.html` é público; qualquer pessoa consegue ler a senha que está nele. No console do HiveMQ Cloud crie duas credenciais:

- **painel_leitura** → permissão só de *Subscribe* em `sorveteria/#`. Essa vai no `index.html`.
- **dispositivos** → permissão de *Publish* em `sorveteria/#`. Essa vai só no firmware.

Assim, mesmo que alguém pegue a senha do painel, não consegue publicar temperatura falsa.

### 9. Gravar o firmware

Abra `firmware/nevaska_freezer/nevaska_freezer.ino`, preencha o bloco de configuração (loja, freezer, Wi-Fi, HiveMQ, URL da Vercel e `DEVICE_KEY`) e grave em cada placa. Atenção ao comentário sobre o **resistor fixo do NTC**: para a faixa de freezer ele deve ser de ~100 kΩ (ou 47 kΩ), e o valor em `R_SERIE` tem de bater com o que está soldado na placa.

Bibliotecas: **PubSubClient** e o core **esp32** da Espressif.

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | Exemplo / padrão | Para que serve |
|---|---|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | sim | criadas pelo Upstash | banco de estado |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | sim | gerar no passo 3 | Web Push |
| `VAPID_SUBJECT` | sim | `mailto:ti@nevaska.com.br` | contato exigido pelo Web Push |
| `DEVICE_KEY` | sim | aleatório | autentica o ESP32 |
| `CRON_SECRET` | sim | aleatório | autentica watchdog e teste |
| `TELEGRAM_BOT_TOKEN` | recomendada | `123:ABC...` | canal Telegram |
| `TELEGRAM_CHAT_IDS` | recomendada | `-1001234567890` | grupo(s) que recebem |
| `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` | opcional | | alarme crítico |
| `LIMITE_TEMP_C` | não | `-12` | temperatura de alerta (°C) |
| `LIMITES_FREEZERS` | não | `{"NEVASKA_SC/freezer_02": -8}` | limite por freezer |
| `HISTERESE_C` | não | `2` | quanto precisa baixar para sair do alerta |
| `TOLERANCIA_MIN` | não | `5` | minutos acima do limite antes de alertar |
| `REPETIR_ALERTA_MIN` | não | `30` | repete o aviso enquanto o problema continuar (0 = não repete) |
| `OFFLINE_MIN` | não | `3` | minutos sem dados para considerar offline |
| `NOMES_LOJAS` | não | `{"NEVASKA_SC":"Santa Cruz","NEVASKA_BERNARDINO":"Bernardino"}` | nome nas mensagens |
| `APP_URL` | não | `https://nevaska.vercel.app/` | link aberto ao tocar na notificação |

Depois de mudar qualquer variável, faça um **Redeploy** para valer.

## Ativando nos celulares da equipe

**Android (Chrome):** abrir o site → tocar no banner amarelo "Ativar os alertas" → Permitir. Chega na hora uma notificação de confirmação. Recomendado: menu do Chrome → "Adicionar à tela inicial", e em Configurações → Apps → Chrome → Bateria, deixar **sem restrição** (alguns aparelhos Xiaomi/Samsung são agressivos com economia de bateria).

**iPhone (iOS 16.4 ou mais recente):** abrir o site no Safari → Compartilhar → **Adicionar à Tela de Início** → abrir o Nevaska **pelo ícone** → tocar em "Ativar os alertas" → Permitir. No iPhone o push só existe dentro do app instalado; aberto pelo Safari não funciona, e o painel avisa isso. Se a pessoa usa modos de Foco (Trabalho, Dormir), precisa liberar o Nevaska e o Telegram nas exceções.

## Roteiro de testes antes de entregar

1. **Notificação chega com tela bloqueada**
   ```bash
   curl -H "Authorization: Bearer SEU_CRON_SECRET" https://SEU-PROJETO.vercel.app/api/teste-alerta
   ```
   Bloqueie os celulares, feche o app (tire da multitarefa) e rode o comando. Todos devem receber no push e no Telegram. A resposta mostra o resultado de cada canal. Use `?urgente=1` para testar o alarme do Pushover.

2. **Alerta de temperatura** (simulando o ESP32; com `TOLERANCIA_MIN=0` temporariamente para não esperar 5 min)
   ```bash
   curl -X POST https://SEU-PROJETO.vercel.app/api/telemetria \
     -H "Content-Type: application/json" -H "x-chave-dispositivo: SEU_DEVICE_KEY" \
     -d '{"loja":"NEVASKA_SC","freezer":"freezer_99","temp":-3}'
   ```
   Depois mande `"temp":-20` para ver a mensagem de normalização.

3. **Queda de energia:** com um ESP32 real rodando, desligue-o da tomada. Em até ~3–4 minutos deve chegar "SEM SINAL". Religue: chega "Sinal restabelecido". No painel, o card fica cinza com "OFFLINE" em ~30 s (Last Will do MQTT).

4. **Sensor:** desconecte o NTC com o ESP32 ligado. Deve chegar "FALHA NO SENSOR".

5. Os testes automáticos da lógica rodam com `npm test`.

Depois dos testes, lembre de remover o `freezer_99` de teste: no console do Upstash, apague o membro `NEVASKA_SC/freezer_99` do conjunto `nv:freezers` e a chave `nv:f:NEVASKA_SC/freezer_99` (senão o watchdog vai alertar que ele ficou offline). O mesmo vale quando um freezer for desativado de verdade.

## Sobre "100% confiável"

Nenhum canal sozinho garante 100%: o celular pode estar sem bateria, sem sinal, no silencioso ou com um modo de Foco ativo. Por isso a solução aposta em **redundância**, que é o que sistemas profissionais de monitoramento de câmara fria fazem:

- Dois caminhos independentes até o celular (Web Push + Telegram) e, para quem precisa, um terceiro que toca como alarme (Pushover).
- Aviso repetido a cada 30 minutos enquanto o problema continuar, para não depender de uma única notificação.
- Detecção de falha do próprio sistema: queda de energia, internet, travamento do ESP32 e sensor rompido viram alerta, em vez de silêncio.
- Mais de uma pessoa recebendo por loja.
- O push carrega `urgency: high` e fica guardado por até 12 h no Google/Apple se o celular estiver sem internet, sendo entregue quando ele voltar.

Um ponto de atenção que fica fora do software: hoje a queda de energia é percebida porque o ESP32 e o roteador apagam junto com a loja, então o alerta "SEM SINAL" sai normalmente, mas não dá para saber a temperatura durante o apagão. Se no futuro vocês colocarem um nobreak pequeno no roteador + ESP32, o sistema continua medindo durante a queda (e aí o alerta passa a vir pela temperatura subindo). Nesse cenário vale adicionar ao ESP32 um sensor simples de "tem energia na tomada" para continuar recebendo o aviso de queda separado.
