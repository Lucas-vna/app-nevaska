# Nevaska — Monitoramento de freezers com alertas em segundo plano

Este projeto faz duas coisas: mostra a temperatura dos freezers num painel (PWA) e **avisa no celular quando algo dá errado, mesmo com a tela bloqueada e o app fechado**.

A ideia central é que **quem decide se tem alerta é o servidor, não o celular.** O celular só recebe o aviso pronto, pelo mesmo canal que o WhatsApp e o banco usam (o serviço de push do Google e da Apple).

O projeto **não usa mais MQTT nem HiveMQ** (o HiveMQ Cloud Serverless será desativado em 31/12/2026). Tudo passa pela Vercel.

## Como funciona

```
 ESP32 + DS18B20 ─ HTTPS a cada 60 s ─►  Vercel /api/telemetria
                                          │  guarda a leitura no Supabase (Postgres)
                                          │  regras: tolerância, histerese, repetição
                                          ▼
   Painel (PWA) ◄── /api/estado ──── Supabase
                                          │
   agendador 1 min ──► /api/watchdog ─────┤  (+ verificação "de carona" nas telemetrias)
                                          ▼
                                     notificar() ──┬──► Web Push (Android + iPhone PWA)
                                                   ├──► Telegram (grupo da equipe)
                                                   └──► Pushover (opcional, alarme crítico)
```

- O **ESP32** lê o sensor DS18B20 a cada 5 s (atualizando o display OLED e os LEDs) e envia a média para a Vercel a cada 60 s. O limite usado no display e nos LEDs vem do servidor, então ele é configurado num lugar só.
- O **servidor** guarda a última leitura, avalia as regras e dispara os alertas.
- O **painel** consulta o servidor a cada 20 s (só enquanto está aberto na tela). Não tem senha de broker no navegador.
- **Queda de energia** é percebida pela ausência de envios: se um freezer fica 3 minutos sem mandar nada, sai o alerta "SEM SINAL". Isso cobre queda de luz, internet da loja fora e ESP32 travado.

## Estrutura dos arquivos

```
index.html               painel
sw.js                    service worker que recebe o push com o app fechado
manifest.json            manifest do PWA (necessário para instalar no iPhone)
icons/                   ícones do app e da notificação (pode trocar pelos da marca)
api/telemetria.js        recebe a leitura do ESP32, guarda e decide os alertas
api/estado.js            entrega ao painel o estado atual de todos os freezers
api/watchdog.js          detecta freezer sem sinal (queda de energia/internet)
api/inscrever.js         cadastra/remove o celular para receber push
api/config.js            entrega ao painel a chave pública VAPID, lojas e limites
api/teste-alerta.js      dispara uma notificação de teste em todos os canais
lib/                     regras, envio de notificações, banco (db.js), autenticação
supabase/schema.sql      script que cria as tabelas no Supabase (rodar uma vez)
tests/                   testes automáticos (npm test)
firmware/                sketch do ESP32 (fica no Git, mas não é publicado no site)
vercel.json              cabeçalhos do sw.js e do manifest
.gitignore               impede node_modules e .env de irem para o Git
.vercelignore            impede firmware/tests/README de virarem páginas públicas
```

## Passo a passo de implantação

### 1. Copiar para o repositório

Coloque todos os arquivos na raiz do repositório que a Vercel publica e faça o push (`git add .`, `git commit -m "..."`, `git push`). Como existe `package.json`, a Vercel instala as dependências sozinha no deploy.

Para rodar os testes localmente: `npm install` e depois `npm test`.

### 2. Criar o banco (Supabase, gratuito)

O banco guarda a última leitura de cada freezer, a situação dos alertas e a lista de celulares inscritos. As funções da Vercel não têm memória entre uma chamada e outra, então tudo isso precisa ficar num banco.

1. Crie uma conta em **supabase.com** e clique em **New project**. Escolha o plano **Free**, dê um nome (ex.: `nevaska`), crie uma senha para o banco (guarde, mas o sistema não vai usar ela) e escolha a região **South America (São Paulo)**.
2. Quando o projeto terminar de ser criado, abra **SQL Editor → New query**, cole todo o conteúdo do arquivo `supabase/schema.sql` e clique em **Run**. Deve aparecer "Success. No rows returned". Se rodar duas vezes por engano, não tem problema.
3. Em **Project Settings → API Keys** (em alguns painéis aparece como **API** ou **Data API**), copie:
   - a **Project URL** → variável `SUPABASE_URL`;
   - a chave **secreta**: a `service_role` (às vezes na aba "Legacy API keys") ou a `secret` (começa com `sb_secret_`) → variável `SUPABASE_SERVICE_ROLE_KEY`.

> Use a chave **secreta** só na Vercel. Nunca coloque ela no `index.html` nem no firmware. A chave pública (`anon`/`publishable`) não é usada pelo projeto, e o script deixou o banco fechado para ela: mesmo que alguém a encontre, não consegue ler nem gravar nada.

**Sobre custo:** o plano gratuito do Supabase não limita o número de requisições; os limites são 500 MB de banco e 5 GB de tráfego por mês, e o sistema usa uma fração mínima disso. O ponto de atenção é que projetos gratuitos são **pausados depois de 1 semana sem atividade**. Como os ESP32 gravam no banco a cada minuto, isso não deve acontecer; mas se um dia todas as placas ficarem desligadas por mais de uma semana, entre no painel do Supabase e clique em **Restore** no projeto. O plano gratuito permite até 2 projetos ativos por conta.

### 3. Gerar as chaves do Web Push (VAPID)

No computador, dentro da pasta do projeto:

```bash
npx web-push generate-vapid-keys
```

Copie a *Public Key* para `VAPID_PUBLIC_KEY` e a *Private Key* para `VAPID_PRIVATE_KEY`. Em `VAPID_SUBJECT` coloque um contato, por exemplo `mailto:ti@nevaska.com.br`.

> Gere uma vez só. Se trocar as chaves depois, todos os celulares precisam ativar os alertas de novo.

### 4. Criar os segredos

Gere valores aleatórios (pode ser `openssl rand -hex 32` ou um gerador de senha):

- `DEVICE_KEY` → vai no firmware de todos os ESP32 (autentica o envio das leituras).
- `CRON_SECRET` → autentica o agendador e o endpoint de teste.
- `PAINEL_CHAVE` → **opcional.** Se existir, o painel pede essa senha uma vez em cada celular (fica salva no aparelho). Se não existir, qualquer pessoa com o link vê as temperaturas, mas não consegue alterar nada.

### 5. Configurar o Telegram (canal redundante)

1. No Telegram, fale com **@BotFather**, envie `/newbot` e siga as instruções. Guarde o token em `TELEGRAM_BOT_TOKEN`.
2. Crie um grupo (ex.: "Alertas Nevaska"), adicione o bot e as pessoas responsáveis.
3. No grupo, envie `/start@NomeDoSeuBot`.
4. Abra no navegador `https://api.telegram.org/bot<TOKEN>/getUpdates` e procure `"chat":{"id":-100...`. Esse número (com o sinal de menos) vai em `TELEGRAM_CHAT_IDS`. Pode colocar mais de um, separados por vírgula.
5. Peça para cada pessoa abrir o grupo e garantir que as notificações estão ativas (de preferência com um som próprio, para diferenciar dos outros grupos).

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

> O plano Hobby da Vercel é voltado para uso pessoal; como isso é um sistema de cliente em produção, o Pro é o caminho mais correto contratualmente, e ainda resolve o agendamento.

Mesmo que o agendador atrase, as telemetrias recebidas também rodam a verificação "de carona" (no máximo uma vez a cada 50 s). Se a loja de Santa Cruz cair inteira, os freezers de Bernardino continuam enviando e o alerta sai do mesmo jeito. O agendador continua necessário para o caso de **todas** as lojas ficarem fora ao mesmo tempo.

### 7. (Opcional) Pushover para alarme crítico

Para quem precisa ser **acordado** (dono, gerente de plantão), o Pushover tem prioridade de emergência: toca uma sirene, fura o modo silencioso e repete a cada minuto até a pessoa tocar em "Confirmar". Cada pessoa instala o app (licença única por plataforma, após 30 dias de teste). Crie uma aplicação em pushover.net, um *Delivery Group* com as pessoas e preencha `PUSHOVER_APP_TOKEN` e `PUSHOVER_USER_KEY` (a chave do grupo). Se não preencher, o canal fica desligado.

### 8. Gravar o firmware novo nos ESP32 (obrigatório)

O firmware antigo só publicava no MQTT. Sem o firmware novo, **o painel fica vazio e os alertas não funcionam**.

1. Faça uma **cópia** de `firmware/nevaska_freezer/` fora da pasta do repositório (é nela que você vai colocar as senhas reais).
2. Preencha o bloco de configuração: Wi-Fi (rede **2.4 GHz**), `URL_TELEMETRIA`, `CHAVE_DISPOSITIVO` (= `DEVICE_KEY` da Vercel), `LOJA_ID` e `FREEZER_ID` (um diferente para cada placa).
3. Hardware considerado: sensor **DS18B20** no pino 4, LED verde no 26, LED vermelho no 27 e display **OLED SSD1306** (I2C, endereço 0x3C). Se a montagem for diferente, ajuste os pinos no bloco de hardware.
4. Bibliotecas: **OneWire**, **DallasTemperature**, **Adafruit GFX Library** e **Adafruit SSD1306** (a PubSubClient não é mais usada). Placa: "esp32" by Espressif.
5. Abra o Monitor Serial (115200): deve aparecer `[HTTP] 200 {"ok":true,"limite":...}` a cada minuto. A última linha do display também mostra a situação: `Nuvem: OK`, `Nuvem: chave errada` (401), `Wi-Fi: sem conexao` etc. `400` = nome de loja/freezer com caractere inválido.

### 9. Desligar o HiveMQ

Depois que todas as placas estiverem com o firmware novo e aparecendo no painel, o HiveMQ não é mais usado. Pode apagar o cluster "Free #1" no console deles (ou só deixar que ele seja desativado em 31/12/2026).

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | Exemplo / padrão | Para que serve |
|---|---|---|---|
| `SUPABASE_URL` | sim | `https://xxxx.supabase.co` | endereço do banco |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | chave secreta do Supabase | acesso do servidor ao banco |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | sim | gerar no passo 3 | Web Push |
| `VAPID_SUBJECT` | sim | `mailto:ti@nevaska.com.br` | contato exigido pelo Web Push |
| `DEVICE_KEY` | sim | aleatório | autentica o ESP32 |
| `CRON_SECRET` | sim | aleatório | autentica watchdog e teste |
| `TELEGRAM_BOT_TOKEN` | recomendada | `123:ABC...` | canal Telegram |
| `TELEGRAM_CHAT_IDS` | recomendada | `-1001234567890` | grupo(s) que recebem |
| `PAINEL_CHAVE` | opcional | aleatório | senha para abrir o painel |
| `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` | opcional | | alarme crítico |
| `LIMITE_TEMP_C` | não | `-12` | temperatura de alerta (°C) |
| `LIMITES_FREEZERS` | não | `{"NEVASKA_SC/freezer_02": -8}` | limite por freezer |
| `HISTERESE_C` | não | `2` | quanto precisa baixar para sair do alerta |
| `TOLERANCIA_MIN` | não | `5` | minutos acima do limite antes de alertar |
| `REPETIR_ALERTA_MIN` | não | `30` | repete o aviso enquanto o problema continuar (0 = não repete) |
| `OFFLINE_MIN` | não | `3` | minutos sem dados para considerar offline |
| `NOMES_LOJAS` | não | `{"NEVASKA_SC":"Santa Cruz","NEVASKA_BERNARDINO":"Bernardino"}` | nomes das abas e das mensagens |
| `APP_URL` | não | `https://nevaska.vercel.app/` | link aberto ao tocar na notificação |

Depois de mudar qualquer variável, faça um **Redeploy** para valer. Para abrir uma loja nova, basta incluí-la em `NOMES_LOJAS` e gravar as placas com o novo `LOJA`: a aba aparece sozinha no painel.

## Ativando nos celulares da equipe

**Android (Chrome):** abrir o site → tocar no banner amarelo "Ativar os alertas" → Permitir. Chega na hora uma notificação de confirmação. Recomendado: menu do Chrome → "Adicionar à tela inicial", e em Configurações → Apps → Chrome → Bateria, deixar **sem restrição** (alguns aparelhos Xiaomi/Samsung são agressivos com economia de bateria).

**iPhone (iOS 16.4 ou mais recente):** abrir o site no Safari → Compartilhar → **Adicionar à Tela de Início** → abrir o Nevaska **pelo ícone** → tocar em "Ativar os alertas" → Permitir. No iPhone o push só existe dentro do app instalado; aberto pelo Safari não funciona, e o painel avisa isso. Se a pessoa usa modos de Foco (Trabalho, Dormir), precisa liberar o Nevaska e o Telegram nas exceções.

## Roteiro de testes antes de entregar

1. **Notificação chega com tela bloqueada**
   ```bash
   curl -H "Authorization: Bearer SEU_CRON_SECRET" https://SEU-PROJETO.vercel.app/api/teste-alerta
   ```
   Bloqueie os celulares, feche o app (tire da multitarefa) e rode o comando. Todos devem receber no push e no Telegram. A resposta mostra o resultado de cada canal. Use `?urgente=1` para testar o alarme do Pushover. (No Windows/PowerShell use `curl.exe` em vez de `curl`.)

2. **Alerta de temperatura** (simulando o ESP32; com `TOLERANCIA_MIN=0` temporariamente para não esperar 5 min)
   ```bash
   curl -X POST https://SEU-PROJETO.vercel.app/api/telemetria \
     -H "Content-Type: application/json" -H "x-chave-dispositivo: SEU_DEVICE_KEY" \
     -d '{"loja":"NEVASKA_SC","freezer":"freezer_99","temp":-3}'
   ```
   O `freezer_99` aparece no painel em vermelho e chega o alerta. Depois mande `"temp":-20` para ver a mensagem de normalização.

3. **Queda de energia:** com um ESP32 real rodando, desligue-o da tomada. Em até ~3–4 minutos chega "SEM SINAL" e o card fica cinza com "OFFLINE" no painel. Religue: chega "Sinal restabelecido".

4. **Sensor:** desconecte o DS18B20 com o ESP32 ligado. No envio seguinte chega "FALHA NO SENSOR" e o card mostra "ERRO".

5. Os testes automáticos da lógica rodam com `npm test`.

Depois dos testes, remova o `freezer_99`: no Supabase, abra **Table Editor → freezers**, marque a linha `NEVASKA_SC/freezer_99` e apague (senão o watchdog vai alertar que ele ficou offline). O mesmo vale quando um freezer for desativado de verdade.

## Sobre "100% confiável"

Nenhum canal sozinho garante 100%: o celular pode estar sem bateria, sem sinal, no silencioso ou com um modo de Foco ativo. Por isso a solução aposta em **redundância**, que é o que sistemas profissionais de monitoramento de câmara fria fazem:

- Dois caminhos independentes até o celular (Web Push + Telegram) e, para quem precisa, um terceiro que toca como alarme (Pushover).
- Aviso repetido a cada 30 minutos enquanto o problema continuar, para não depender de uma única notificação.
- Detecção de falha do próprio sistema: queda de energia, internet, travamento do ESP32 e sensor rompido viram alerta, em vez de silêncio.
- Mais de uma pessoa recebendo por loja.
- O push carrega `urgency: high` e fica guardado por até 12 h no Google/Apple se o celular estiver sem internet, sendo entregue quando ele voltar.

Um ponto de atenção que fica fora do software: hoje a queda de energia é percebida porque o ESP32 e o roteador apagam junto com a loja, então o alerta "SEM SINAL" sai normalmente, mas não dá para saber a temperatura durante o apagão. Se no futuro vocês colocarem um nobreak pequeno no roteador + ESP32, o sistema continua medindo durante a queda (e aí o alerta passa a vir pela temperatura subindo). Nesse cenário vale adicionar ao ESP32 um sensor simples de "tem energia na tomada" para continuar recebendo o aviso de queda separado.
