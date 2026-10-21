# Migração do ngrok para domínio próprio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Servir a API em `https://<PUBLIC_DOMAIN>` via Caddy e permitir que Kindle e app troquem a URL vinculada somente quando o novo endereço provar ser o mesmo servidor (`serverId`).

**Architecture:** O servidor ganha uma identidade persistente (`server_identity`) exposta em `GET /v1/server` e, de forma aditiva, nas respostas de sync/KOReader. Cada cliente memoriza o `serverId`, bloqueia se ele mudar e oferece "Migrar servidor", que só troca a URL após `GET /v1/server` no novo endereço devolver o mesmo id. O plugin também passa a tratar falhas de negociação por tempo/conexão como transitórias.

**Tech Stack:** Node 24.15+ (`node:sqlite`, `node:test`), Lua/LuaJIT no KOReader (testes via `integrations/koreader/test/run.py` + lupa), Expo/React Native + TypeScript (`node --test`), Caddy 2, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-19-migracao-dominio-vps-design.md`

## Global Constraints

- Campo `serverId` é string não vazia de até 64 caracteres; `GET /v1/server` → `{ "protocolVersion": 1, "serverId": "<uuid>" }`, Bearer obrigatório.
- `serverId` é aditivo: respostas sem ele (servidor antigo) continuam válidas nos dois clientes.
- Mensagens (copiar exatamente):
  - `SERVER_MISMATCH` = "Servidor diferente do vinculado; fila preservada"
  - `NEEDS_IDENTITY` = "Sincronize uma vez pelo endereço atual antes de migrar"
  - `OTHER_SERVER` = "O novo endereço leva a outro servidor; nada foi alterado"
  - `SAME_URL` = "Esta já é a URL vinculada"
  - `MIGRATED` = "Servidor migrado; enviando pendências"
- Migração nunca altera `activationUnix`, `deviceId`, `generationId`, eventos, progresso, diagnósticos (Kindle) nem `cursor`, `sync_pending`, `sync_conflicts`, token (app).
- O plugin nunca exporta texto bruto de exceção; `reason` ∈ `{timeout, wantread, wantwrite, closed, certificate verify failed, unknown}`.
- Caddy: imagem `caddy:2.10.2-alpine` (versão fixada), perfil `proxy`.
- Commits: o repositório não tem commits e a sessão remota não pode apagar arquivos de lock do git. Os passos "Commit" valem quando a exclusão estiver liberada ou forem feitos pelo usuário.

## Review Focus

1. **Servidor sem `serverId` (deploy antigo) durante a transição** — clientes devem sincronizar normalmente e não memorizar nada. Teste em Task 4 e Task 6.
2. **Migração com o coordenador/motor ocupado no meio de um envio** — deve recusar ("Aguarde o envio atual") sem trocar URL. Teste em Task 5 e Task 7.
3. **URL nova com barra final ou caixa diferente** (`https://Leituras.x.com/`) — normalizada antes de comparar com a vinculada. Teste em Task 5 e Task 7.
4. **`/v1/server` respondendo 401 (token errado no novo endereço)** — mensagem de token, nada muda. Teste em Task 5 e Task 7.
5. **Reinício após migração** — `config.url` e `queue url` persistidos juntos; após `init()` o envio usa a URL nova sem "URL vinculada difere da configuração". Teste em Task 5.

---

### Task 1: Identidade do servidor

**Files:**
- Create: `apps/server/src/identity.js`
- Modify: `apps/server/src/store.js` (`openStore`: chamar `migrateIdentity(db)` após `migrateKOReader`)
- Modify: `apps/server/src/server.js` (rota `/v1/server`; `serverId` na resposta de `/v1/sync`)
- Modify: `apps/server/src/koreader/routes.js` (`serverId` em `status` e `ingest`)
- Test: `apps/server/test/server-identity.test.js`

**Interfaces:**
- Produces: `migrateIdentity(db: DatabaseSync): void`, `getServerId(db: DatabaseSync): string` (em `identity.js`); HTTP `GET /v1/server`.

- [ ] **Step 1: Write the failing tests** (`withServer` igual ao de `sync.test.js`)

```js
test('identidade criada uma vez e estável entre aberturas', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'id-')), 'db.sqlite');
  const a = openStore(path); const id = getServerId(a); a.close();
  const b = openStore(path); assert.equal(getServerId(b), id); b.close();
  assert.match(id, /^[0-9a-f-]{36}$/);
});
test('GET /v1/server exige token e devolve serverId', ...)        // 401 sem/errado; 200 {protocolVersion:1, serverId}
test('serverId presente em /v1/sync, /v1/koreader/status e ingest', ...) // mesmo valor nas três
```
Backup/restore: em `maintenance.test.js`, após o restore existente, `assert.equal(getServerId(restored), getServerId(original))`.

- [ ] **Step 2: Run** `cd apps/server && node --test test/server-identity.test.js` — Expected: FAIL (`identity.js` ausente).
- [ ] **Step 3: Implement** — `CREATE TABLE IF NOT EXISTS server_identity(id INTEGER PRIMARY KEY CHECK(id=1), server_id TEXT NOT NULL)`; `INSERT OR IGNORE ... VALUES(1, crypto.randomUUID())`. Em `routes.js`, para `status` e `ingest`: `body={...body, serverId:getServerId(db)}`. Em `server.js`, `/v1/server` vem depois do `tokenMatches`.
- [ ] **Step 4: Run** `cd apps/server && node --test` — Expected: todos PASS.
- [ ] **Step 5: Commit** `feat(server): identidade persistente e GET /v1/server`

### Task 2: Caddy na VPS + documentação

**Files:**
- Create: `Caddyfile`
- Modify: `compose.yaml`, `.env.example`, `README.md` (nova seção "Publicar na VPS"; trocar "Trocar a URL do servidor não é suportado" por instruções de "Migrar servidor")

**Interfaces:** Produces: variável `PUBLIC_DOMAIN`; `docker compose --profile proxy up -d --build`.

- [ ] **Step 1:** Serviço `caddy`: `image: caddy:2.10.2-alpine`, `profiles: [proxy]`, `ports: ["80:80","443:443","443:443/udp"]`, `environment: PUBLIC_DOMAIN: ${PUBLIC_DOMAIN:?Defina PUBLIC_DOMAIN no .env}`, volumes `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy_data:/data`, `caddy_config:/config`, `depends_on: [api]`, `restart: unless-stopped`.
- [ ] **Step 2:** `Caddyfile` exatamente como no spec (`{$PUBLIC_DOMAIN} { reverse_proxy api:8080 }`); `.env.example` com `PUBLIC_DOMAIN=leituras.seudominio.com`.
- [ ] **Step 3: Verify** `PUBLIC_DOMAIN=x.example READING_LOG_TOKEN=$(printf 'a%.0s' {1..32}) docker compose --profile proxy config -q` → exit 0; `docker run --rm -e PUBLIC_DOMAIN=x.example -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile` → "Valid configuration" (se Docker indisponível, registrar e seguir).
- [ ] **Step 4:** README "Publicar na VPS": os 5 passos do spec (A/AAAA, firewall 80/443, `--profile proxy up`, `curl .../health`, `openssl s_client -tls1_2 -servername`) e a ordem de implantação de 7 passos.
- [ ] **Step 5: Commit** `feat(infra): Caddy com domínio próprio`

### Task 3: Plugin — classificação das falhas de negociação

**Files:**
- Modify: `integrations/koreader/booksproject.koplugin/native_http.lua:34-35,52`
- Modify: `integrations/koreader/booksproject.koplugin/transport.lua` (repassar `reason`)
- Modify: `integrations/koreader/booksproject.koplugin/coordinator.lua:54` (`lastFailure.reason`)
- Modify: `integrations/koreader/booksproject.koplugin/main.lua:29` (diagnóstico `… / stage / reason`)
- Test: `integrations/koreader/test/test_native_http.lua`, `test_diagnostics.lua`

**Interfaces:** Produces: erro HTTP `{kind, code, stage, reason?}`; erro do Transport `{kind, code, message, stage, reason}`.

- [ ] **Step 1: Write failing asserts** em `test_native_http.lua` (usando o stub `tls.dohandshake` existente):
  - `'wantread'`, `'wantwrite'`, `'timeout'` → `kind=='transient' and code=='timeout' and stage=='handshake' and reason==<valor>`
  - `'closed'` → `kind=='transient' and code=='network' and reason=='closed'`
  - `'certificate verify failed'` → `kind=='protocol' and code=='tls' and reason=='certificate verify failed'`
  - `'certificate expired private-secret'` → `code=='tls' and reason=='unknown'` e `message==nil`
  - Em `test_diagnostics.lua`: texto do diagnóstico contém `protocol / tls / handshake / unknown`.
- [ ] **Step 2: Run** `python integrations/koreader/test/run.py native_http diagnostics` — Expected: FAIL.
- [ ] **Step 3: Implement** — guardar `handshakeReason` local; `networkTimeout` para `timeout|wantread|wantwrite`; nova flag `networkClosed` para `closed` (não `tlsFailure`); `reason` = valor se na lista fixa, senão `'unknown'`, incluído no objeto de erro.
- [ ] **Step 4: Run** `python integrations/koreader/test/run.py` — Expected: "Lua modules: 13 PASS, 0 failures".
- [ ] **Step 5: Commit** `fix(koreader): falhas de negociação por tempo/conexão são transitórias`

### Task 4: Plugin — `serverId` no transporte e no coordenador

**Files:**
- Modify: `transport.lua` (nova `Transport:serverInfo`; repassar `serverId`)
- Modify: `queue.lua` (`Queue:migrateUrl`)
- Modify: `coordinator.lua` (`rememberServer`, checagem antes de `queue:ack`, `connectionVerified(url, serverId)`)
- Modify: `main.lua:111-113` (passar `response.serverId` para `connectionVerified`)
- Test: `test_transport.lua`, `test_queue.lua`, `test_coordinator.lua`

**Interfaces:**
- Produces:
  - `Transport.validServerId(value) -> boolean` (string 1..64)
  - `Transport:serverInfo(url, token, callback(response{serverId}, err))` → `GET /v1/server`; sem `serverId` válido → `err{kind='protocol',code='response'}`
  - `Queue:migrateUrl(url: string, serverId: string)` — transação; `error('Servidor divergente')` se `get('serverId')~=serverId`; grava `url`
  - `Coordinator:rememberServer(serverId) -> boolean` — nil/ inválido → true (servidor antigo); sem memorizado → grava e true; igual → true; diferente → bloqueia (`blocked='protocol'`, `transportBlockCode='server_mismatch'`, `error=SERVER_MISMATCH`) e false
  - `Coordinator:connectionVerified(url, serverId) -> boolean`
- `failureCodes` ganha `server_mismatch`; `recoverable` em `connectionVerified` **não** o inclui.

- [ ] **Step 1: Write failing asserts**
  - transport: `serverInfo` faz GET em `…/v1/server` com Bearer; `{protocolVersion=1,serverId='s1'}` → `response.serverId=='s1'`; `serverId=''` ou 65 chars → `err.code=='response'`; 401 → `err.kind=='auth'`.
  - queue: `migrateUrl` com id igual troca `get('url')`; com id diferente lança e mantém a URL; `activationUnix/deviceId/generationId` inalterados.
  - coordinator: primeira resposta de ingest com `serverId='s1'` grava `q:get('serverId')=='s1'`; resposta seguinte com `'s2'` → nenhum `ack` (pendências iguais), `c.blocked=='protocol'`, `q:get('transportBlockCode')=='server_mismatch'`; `c:connectionVerified(url,'s1')` não desbloqueia; resposta sem `serverId` → `ack` normal e nada gravado (Review Focus 1).
- [ ] **Step 2: Run** `python integrations/koreader/test/run.py transport queue coordinator` — Expected: FAIL.
- [ ] **Step 3: Implement** conforme Interfaces; em `Coordinator:send`, chamar `rememberServer(response.serverId)` antes do `pcall(self.queue.ack, …)` e, se false, encerrar sem `ack`.
- [ ] **Step 4: Run** `python integrations/koreader/test/run.py` — Expected: 13 PASS.
- [ ] **Step 5: Commit** `feat(koreader): memorizar e verificar identidade do servidor`

### Task 5: Plugin — menu "Migrar servidor"

**Files:**
- Modify: `main.lua` (item de menu + `Plugin:migrate(newUrl)`)
- Test: `test_menu.lua`

**Interfaces:**
- Consumes: `Transport.normalizeUrl`, `Transport:serverInfo`, `Queue:migrateUrl`, `Coordinator:connectionVerified`, `Coordinator:syncNow`.
- Produces: `Plugin:migrate(newUrl: string, done?: function(ok: boolean, message: string))`; item `{text='Migrar servidor', enabled_func=activationUnix~=nil}` que abre `Input` com a URL atual e chama `migrate`.

- [ ] **Step 1: Write failing asserts** (stub de transporte no plugin já ativado, `queue:set('serverId','s1')`):
  - item ausente/desabilitado antes da ativação;
  - id igual → `queue:get('url')==new`, `settings.config.url==new`, `syncNow` chamado, mensagem `MIGRATED`;
  - id diferente → URL inalterada, `OTHER_SERVER`;
  - sem `serverId` memorizado → `NEEDS_IDENTITY`, `serverInfo` não chamado;
  - URL igual (inclusive `https://books.example/`) → `SAME_URL` (Review Focus 3);
  - `coordinator.busy=true` → "Aguarde o envio atual" (Review Focus 2);
  - erro 401 → mensagem "Token pessoal inválido", nada muda (Review Focus 4);
  - após migração, novo `Plugin:new(...):init()` no mesmo diretório → `coordinator:send()` não define "URL vinculada difere da configuração" (Review Focus 5).
- [ ] **Step 2: Run** `python integrations/koreader/test/run.py menu` — Expected: FAIL.
- [ ] **Step 3: Implement** — ordem de checagens do spec (passos 1–8); em sucesso: `pcall(queue.migrateUrl)`, `config.url=new`, `saveConfig()`, `coordinator:connectionVerified(new, id)`, `coordinator:syncNow()`.
- [ ] **Step 4: Run** `python integrations/koreader/test/run.py && node integrations/koreader/package.mjs` — Expected: 13 PASS; zip gerado em `.local/koreader-adapter/booksproject.koplugin.zip`.
- [ ] **Step 5: Commit** `feat(koreader): migrar servidor com verificação de identidade`

### Task 6: App — memorizar e verificar `serverId`

**Files:**
- Modify: `apps/mobile/src/sync/store.ts` (migração `user_version=8`; `settings()` com `serverId`; `apply` checa/grava)
- Modify: `apps/mobile/src/sync/types.ts` (`SyncSettings.serverId: string | null`; `SyncResponse.serverId?: string`)
- Modify: `apps/mobile/src/sync/transport.ts` (`validateResponse`; constante `SERVER_MISMATCH`)
- Test: `apps/mobile/test/sync.test.mjs`

**Interfaces:**
- Produces: `export const SERVER_MISMATCH` (transport.ts); `SyncStore.settings(): {…, serverId: string | null}`; `SyncStore.apply` lança `new SyncError("protocol", SERVER_MISMATCH)` antes de qualquer escrita quando divergente.

- [ ] **Step 1: Write failing tests**
  - `validateResponse` aceita sem `serverId`; rejeita `serverId` não string ou > 64.
  - primeira sync contra `createAppServer` real → `(await store.settings()).serverId === getServerId(db)`.
  - resposta com `serverId` diferente → engine `status.phase==="blocked"`, `settings.fatal===SERVER_MISMATCH`, `cursor` e `pendingCount()` inalterados.
  - resposta sem `serverId` → aplicada; `serverId` continua `null` (Review Focus 1).
  - banco em `user_version=7` migra para 8 preservando `url` e `cursor`.
- [ ] **Step 2: Run** `cd apps/mobile && node --test test/sync.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** — `ALTER TABLE sync_settings ADD COLUMN server_id TEXT; PRAGMA user_version=8;`; checagem no início da transação de `apply`.
- [ ] **Step 4: Run** `cd apps/mobile && npm test && npx tsc --noEmit` — Expected: PASS, sem erros de tipo.
- [ ] **Step 5: Commit** `feat(mobile): memorizar e verificar identidade do servidor`

### Task 7: App — "Migrar servidor"

**Files:**
- Modify: `apps/mobile/src/sync/transport.ts` (`fetchServerInfo`)
- Modify: `apps/mobile/src/sync/store.ts` (`migrate`)
- Modify: `apps/mobile/src/sync/useSync.ts` (`migrate`)
- Modify: `apps/mobile/src/sync/SyncSettings.tsx` (botão + campo na Disclosure "Conexão")
- Test: `apps/mobile/test/sync.test.mjs`, `apps/mobile/test/settingsScreen.test.mjs`

**Interfaces:**
- Consumes: `normalizeUrl`, `SERVER_MISMATCH`, `SyncError`, `AUTH_ERROR`.
- Produces:
  - `fetchServerInfo(url, token, options{signal?, timeoutMs?, fetcher?}): Promise<{serverId: string}>` — mesmos erros de `sendSync` (401/403 → auth, ≥500/429/rede → network, formato inválido → protocol), `redirect: "error"`, timeout 15000.
  - `SyncStore.migrate(url: string, serverId: string): Promise<void>` — transação; lança `Error(OTHER_SERVER)` se `server_id` diferente ou nulo; grava `url`; `fatal=NULL` somente se `fatal===SERVER_MISMATCH`.
  - `useSync().migrate(urlInput: string): Promise<string>` → devolve `MIGRATED` ou lança com a mensagem do spec; pausa o motor (`setActive(false)` + `settled()`) durante a verificação, como `configure`; recusa com "Aguarde o envio atual" se `configBusy`.

- [ ] **Step 1: Write failing tests**
  - `fetchServerInfo` com `fetcher` falso: 200 válido; 401 → `kind==="auth"`; corpo sem `serverId` → `protocol`.
  - `store.migrate` igual → `url` nova, `cursor`/pendências/conflitos iguais; diferente ou `server_id` nulo → lança, URL antiga mantida.
  - URL nova `https://Servidor.Example/` normalizada antes de comparar com a atual (Review Focus 3).
  - `settingsScreen.test.mjs`: botão "Migrar servidor" renderizado só com `settings.url`; mensagens `NEEDS_IDENTITY`, `OTHER_SERVER`, `SAME_URL` presentes no fluxo.
- [ ] **Step 2: Run** `cd apps/mobile && node --test test/sync.test.mjs test/settingsScreen.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** conforme Interfaces; ordem de checagens do spec (Parte 4, passos 1–7); após sucesso, `sync()`.
- [ ] **Step 4: Run** `cd apps/mobile && npm test && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): migrar servidor com verificação de identidade`

### Task 8: Verificação final

- [ ] **Step 1:** `pnpm test` na raiz — Expected: dev, server e mobile PASS.
- [ ] **Step 2:** `python integrations/koreader/test/run.py` — Expected: "13 PASS, 0 failures".
- [ ] **Step 3:** `node integrations/koreader/package.mjs` — zip do plugin atualizado.
- [ ] **Step 4:** Conferir o spec seção a seção contra o código (critérios de sucesso 1–5) e registrar no README qualquer passo manual restante (DNS, build EAS).
