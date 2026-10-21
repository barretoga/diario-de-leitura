# Migração do ngrok para domínio próprio na VPS — Design

Data: 2026-10-19 · Status: aguardando revisão

## Contexto e objetivo

O plugin KOReader (Kindle) e o app Android estão vinculados a
um túnel ngrok temporário. A API já roda na VPS, mas o
tráfego ainda passa pelo ngrok gratuito, cuja borda termina o TLS. No Kindle, o
envio falha com `protocol/tls/handshake` enquanto o teste de conexão passa.

Objetivo: servir a API em um subdomínio próprio na VPS, com HTTPS via Caddy, e
migrar os dois clientes para a nova URL **sem** perder fila, ativação, cursores ou
conflitos, e **sem** enfraquecer a trava que impede um aparelho de sincronizar
com outro banco.

### Critérios de sucesso

1. `https://<PUBLIC_DOMAIN>/health` responde 200 com certificado Let's Encrypt
   válido e TLS 1.2 disponível.
2. Kindle e celular trocam para a URL nova pela opção "Migrar servidor"; as 38
   pendências do Kindle são confirmadas pelo servidor após a migração.
3. Um cliente recusa migrar (e recusa sincronizar) para um servidor cujo
   `serverId` difere do memorizado.
4. Falhas de negociação por tempo/conexão encerrada no Kindle geram nova
   tentativa automática, não bloqueio.
5. O ngrok pode ser desligado ao final.

### Fora do escopo

- Troca de URL sem `serverId` memorizado (o caminho exige uma sincronização
  pelo endereço atual antes).
- Desvincular/reativar aparelhos.
- Migração de VPS/hospedagem do banco (o banco permanece o mesmo).

## Decisões

| Tema | Decisão |
|------|---------|
| Abordagem | Identidade do servidor (`serverId`) + migração verificada pelos clientes |
| Proxy HTTPS | Caddy em contêiner, perfil `proxy` no `compose.yaml` |
| Domínio | Subdomínio de domínio próprio do usuário, em `PUBLIC_DOMAIN` no `.env` |
| Clientes | Kindle (plugin KOReader) e app Android |
| Correção TLS | Incluída no plugin |

## Parte 1 — Servidor

### Identidade

- Migração nova cria `server_identity(id INTEGER PRIMARY KEY CHECK(id=1), server_id TEXT NOT NULL)`
  e insere um UUID v4 (`crypto.randomUUID()`) quando a tabela está vazia. Executa
  na abertura do banco, como as migrações existentes em `store.js`.
- O `serverId` vive no banco: backup e restauração (`maintenance.js`) o preservam.
- Função `getServerId(db)` exportada pelo store.

### API

- `GET /v1/server` (Bearer token obrigatório, mesma autenticação de `/v1/sync`):
  `200 { "protocolVersion": 1, "serverId": "<uuid>" }`.
- Campo aditivo `serverId` nas respostas de:
  - `POST /v1/sync`
  - `GET /v1/koreader/status`
  - `POST /v1/koreader/ingest`
- Clientes antigos ignoram o campo; nenhum contrato existente muda.

### Testes

- Identidade criada uma vez e estável entre aberturas do banco.
- Identidade preservada por backup → restore.
- `GET /v1/server` exige token (401 sem/errado) e devolve o formato acima.
- `serverId` presente nas três respostas.

## Parte 2 — Infraestrutura (VPS)

- `compose.yaml`: serviço `caddy` (imagem oficial, versão fixada), `profiles: [proxy]`,
  portas `80:80`, `443:443` (+ `443:443/udp`), volumes `caddy_data` e `caddy_config`,
  `depends_on: api`, `restart: unless-stopped`. A API mantém a porta em
  `127.0.0.1` para uso local.
- `Caddyfile` na raiz:

  ```caddyfile
  {$PUBLIC_DOMAIN} {
      reverse_proxy api:8080
  }
  ```

- `.env.example`: `PUBLIC_DOMAIN=leituras.seudominio.com`.
- O Caddy usa TLS 1.2–1.3 por padrão (compatível com o plugin, que exige TLS 1.2)
  e renova o certificado automaticamente.
- README, nova seção "Publicar na VPS":
  1. Registro DNS A (e AAAA só se a VPS tiver IPv6 funcional) para o subdomínio.
  2. Firewall liberando 80/tcp e 443/tcp.
  3. `docker compose --profile proxy up -d --build`.
  4. Verificação: `curl -sS https://<PUBLIC_DOMAIN>/health` e
     `openssl s_client -connect <PUBLIC_DOMAIN>:443 -tls1_2 -servername <PUBLIC_DOMAIN>`.
  5. Remover a instrução "Trocar a URL do servidor não é suportado" e documentar
     "Migrar servidor".

## Parte 3 — Plugin KOReader

### Memorizar identidade

- `Transport:testConnection`, `Transport:send` e a nova `Transport:serverInfo`
  expõem `serverId` quando presente (string não vazia, ≤ 64 chars).
- `Coordinator`: após resposta bem-sucedida, se a fila não tem `serverId`, grava
  `queue:set('serverId', id)`. Se tem e difere, não aplica a confirmação, bloqueia
  com `kind='protocol'`, `code='server_mismatch'`, mensagem
  "Servidor diferente do vinculado; fila preservada". `server_mismatch` **não**
  é desbloqueado por "Testar conexão".
  - Para o ingest, a verificação ocorre antes de `queue:ack`.
- "Testar conexão" também memoriza: `Coordinator:connectionVerified(url, serverId)`
  aplica a mesma regra (grava se vazio; divergente → `server_mismatch`, sem desbloquear).

### "Migrar servidor"

- Novo item de menu, habilitado apenas com `activationUnix` definido.
- Fluxo (`Plugin:migrate(newUrl)`):
  1. `Transport.normalizeUrl`; se inválida → mensagem de URL inválida.
  2. Se igual à URL vinculada → "Esta já é a URL vinculada".
  3. Sem `serverId` memorizado → "Sincronize uma vez pelo endereço atual antes de migrar".
  4. Se o coordenador estiver ocupado → "Aguarde o envio atual".
  5. `Transport:serverInfo(newUrl, token)` → `GET /v1/server`.
  6. Erro de transporte → mensagem do erro; nada muda.
  7. `serverId` diferente → "O novo endereço leva a outro servidor; nada foi alterado".
  8. Igual → `Queue:migrateUrl(newUrl, serverId)` (transação: confere `serverId`,
     grava `url`), `config.url=newUrl`, `saveConfig()`, limpa bloqueios
     recuperáveis (como `connectionVerified`), `syncNow()`, mensagem
     "Servidor migrado; enviando pendências".
- `activationUnix`, `deviceId`, `generationId`, eventos, progresso e diagnósticos
  não mudam.
- "Servidor HTTPS" continua desabilitado após ativação.

### Correção da classificação TLS (`native_http.lua`)

- Na falha de `dohandshake()`:
  - `timeout`, `wantread`, `wantwrite` → `kind='transient'`, `code='timeout'`.
  - `closed` → `kind='transient'`, `code='network'`.
  - Demais → `kind='protocol'`, `code='tls'` (bloqueia, como hoje).
- O erro passa a carregar `reason`, apenas se pertencer à lista fixa
  `{timeout, wantread, wantwrite, closed, certificate verify failed, unknown}`
  (caso contrário `unknown`). O diagnóstico exibe `stage/reason`. Nunca exporta o
  texto bruto da exceção.

### Testes (Lua, `integrations/koreader/test`)

- `test_native_http`: `wantread`/`wantwrite`/`timeout` → transitório timeout;
  `closed` → transitório rede; outro motivo → tls; `reason` fora da lista → `unknown`.
- `test_transport`: `serverInfo` valida formato; `serverId` repassado.
- `test_coordinator`: grava `serverId` na primeira resposta; bloqueia em
  divergência sem `ack`; `connectionVerified` não desbloqueia `server_mismatch`.
- `test_menu`/`test_activation`: migração aceita (URL e config trocadas, fila
  intacta, `syncNow` chamado); recusada por divergência, por falta de `serverId`,
  por erro de rede e por URL igual/inválida; item oculto antes da ativação.
- `test_queue`: `migrateUrl` atômico e recusando `serverId` divergente.

## Parte 4 — App Android

### Memorizar identidade

- Migração do SQLite (próximo `user_version`): `ALTER TABLE sync_settings ADD COLUMN server_id TEXT`.
- `validateResponse` aceita `serverId` opcional (string ≤ 64).
- `store.apply`: na mesma transação, se `server_id` é nulo grava o recebido; se
  difere, lança erro antes de aplicar mudanças; o motor grava `fatal`
  "Servidor diferente do vinculado" (mesmo caminho de bloqueio existente).

### "Migrar servidor"

- Em Configurações → Sincronização → Conexão, visível apenas com URL vinculada.
- Fluxo:
  1. `normalizeUrl`; inválida → mensagem.
  2. Igual à atual → mensagem.
  3. `server_id` nulo → "Sincronize uma vez pelo endereço atual antes de migrar".
  4. Pausa o motor durante a verificação.
  5. `fetchServerInfo(url, token)` → `GET /v1/server`, com timeout e erros no padrão de `sendSync`.
  6. Divergente/erro → mensagem; nada muda.
  7. Igual → `store.migrate(url, serverId)` (transação: confere `server_id`, grava
     `url`, limpa `fatal` se for o de divergência), retoma e chama `sync()`.
- Cursor, `sync_pending`, `sync_conflicts` e o token não mudam.
- A tela KOReader do app passa a usar a nova URL via `settings()`.

### Testes (`apps/mobile/test`)

- `sync.test.mjs`: grava `serverId` na primeira resposta; bloqueia sem aplicar em
  divergência; aceita resposta sem `serverId` (servidor antigo); `migrate`
  atômico e recusando divergência.
- `settingsScreen.test.mjs`: botão só com URL vinculada; migração aceita,
  recusada por divergência, por falta de `serverId` e por erro de rede.

## Ordem de implantação

1. Publicar servidor novo na VPS (ngrok continua apontando para ele).
2. Configurar DNS + `PUBLIC_DOMAIN`, subir Caddy, verificar `/health` e TLS 1.2.
3. Instalar plugin novo no Kindle e build nova do app (EAS).
4. Em cada aparelho, sincronizar uma vez pelo ngrok (memoriza `serverId`).
5. "Migrar servidor" em cada aparelho para `https://<PUBLIC_DOMAIN>`.
6. Confirmar envio das pendências do Kindle e sync do celular.
7. Desligar o agente ngrok.

## Riscos

- **Kindle bloqueado no ngrok antes do passo 4:** "Testar conexão" desbloqueia;
  com a correção TLS, falhas de tempo viram tentativas automáticas. Se o envio
  nunca passar pelo ngrok, `GET /v1/koreader/status` (teste) também grava o
  `serverId`, suficiente para migrar.
- **AAAA apontando para IP sem serviço:** README orienta criar AAAA só com IPv6 funcional.
- **Restaurar backup em outro servidor duplica o `serverId`:** aceitável; é o
  mesmo conjunto de dados.
