# Migrar o PostgreSQL do Railway — procedimento seguro

Fecha o único item que separa "deploy correto" de "API funcionando".

**Estado atual:** a API no Vercel alcança o PostgreSQL do Railway, mas o schema
`nexus` não existe. `/v1/ready` responde `503 not_ready` — corretamente.

**Nada foi executado no banco real.** Este documento é o procedimento verificável
para você executar.

---

## 0. Resumo do que será feito

| Fase | Papel que executa | Arquivo | O que faz |
|---|---|---|---|
| 1 | `postgres` (admin) | `00_prepare.sql` | cria os 4 papéis e as permissões administrativas |
| 1b | `postgres` (admin) | (o instalador faz) | define as senhas via verificador SCRAM |
| 2 | `nexus_migrator` | `migrate.sh` | aplica as 8 migrations |
| 3 | `nexus_migrator` | `20_grant_runtime.sql` | GRANTs de runtime para `nexus_app` |
| — | `nexus_migrator` | `30_verify.sql` | conferência somente-leitura |

O superusuário atua **só na fase 1**. A partir da fase 2, nenhuma conexão é
administrativa.

---

## 1. Quem precisa de quê — a matriz real de privilégios

Levantada lendo as migrations, não por suposição.

### Exige administrador (`postgres`) — só a fase 1

| Comando | Por quê |
|---|---|
| `CREATE ROLE nexus_migrator / nexus_app / nexus_anonymous / nexus_audit_writer` | `CREATE ROLE` é objeto de CLUSTER; exige `CREATEROLE` e, para os atributos `NOSUPERUSER`/`NOBYPASSRLS`, na prática o admin |
| `GRANT CREATE, CONNECT ON DATABASE <db> TO nexus_migrator` | o banco do Railway pertence a `postgres`; só o dono concede |
| `GRANT nexus_audit_writer TO nexus_migrator WITH SET TRUE` | a membership precisa ser criada por quem tem ADMIN no papel |
| `ALTER ROLE ... PASSWORD` | o instalador aplica como admin; um papel não altera a senha de outro |
| `CREATE EXTENSION` (se alguma migration exigisse) | as migrations atuais **não** exigem extensão nenhuma |

### Executado por `nexus_migrator` — fases 2 e 3

| Comando | Como funciona sem superuser |
|---|---|
| `CREATE SCHEMA nexus` | concedido na fase 1 (`GRANT CREATE ON DATABASE`) |
| todo o DDL das 8 migrations | o migrator **é o dono** do schema e das tabelas que cria |
| `ALTER FUNCTION ... OWNER TO nexus_audit_writer` (00007) | exige `SET ROLE` no escritor — concedido na fase 1 com `WITH SET TRUE, INHERIT FALSE` |
| `GRANT ... TO nexus_app` (fase 3) | o migrator é dono dos objetos, então pode conceder |

### O que **não** foi necessário

- **`CREATEROLE` no migrator.** A 00007 traz um bloco `DO` que cria
  `nexus_audit_writer` só se ele ainda não existir. Criando o papel na fase 1,
  esse bloco vira no-op e o migrator nunca precisa de `CREATEROLE`.
- **`SUPERUSER` em qualquer fase depois da 1.**
- **`BYPASSRLS` em qualquer papel.** As migrations rodam com `nexus.owner_id` e
  `nexus.actor_type` definidos na sessão, que é o que as policies exigem.

### Roles e o que cada uma pode

```
nexus_migrator     LOGIN  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
                   + SET ROLE nexus_audit_writer
nexus_app          LOGIN  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
                   (não é credencial — não tem senha)
nexus_anonymous    NOLOGIN NOSUPERUSER NOBYPASSRLS
                   (existe por fidelidade ao modelo; NÃO é usada pelo runtime —
                    medido: nenhuma migration a referencia e o app não a usa)
```

---

## 2. Antes de qualquer coisa: onde está o ledger

**Se o banco já recebeu uma tentativa anterior, não comece pela fase 2.** Leia o
ledger primeiro. É a instrução do item "não re-executar migrations parcialmente
aplicadas sem verificar o ledger", e ela tem motivo:

```
SELECT version, filename, applied_at
  FROM nexus_migrations.schema_migrations
 ORDER BY version;
```

Três resultados possíveis:

| Resultado | Significado | Ação |
|---|---|---|
| erro `relation ... does not exist` | nunca se tentou migrar | siga do passo 3 |
| 8 linhas, versões 1–8 | já migrado | pule para a verificação (passo 6) |
| menos de 8 | **meio migrado** | veja "Diagnóstico" no fim |

Conexão somente-leitura para isso, sem expor credencial:

```sh
railway connect postgres          # abre psql dentro do ambiente, sem URL
```

Depois, dentro do `psql`, cole a consulta acima.

---

## 3. Obter acesso sem manipular a senha

Três caminhos. O primeiro é o recomendado.

### 3a. Recomendado — `railway connect` (a URL nunca existe na sua mão)

```sh
railway login
railway link                      # escolhe o projeto
railway connect postgres          # psql interativo, sobre SSH, sem proxy público
```

O CLI busca as credenciais internamente e abre o `psql`. **Nenhuma senha é
digitada, colada ou exibida.** Você cai num prompt `psql` como `postgres`.

Se preferir o túnel sem cliente interativo:

```sh
railway connect postgres --tunnel-only    # imprime host/porta e mantém aberto
```

Atenção: `--tunnel-only` **imprime a senha**. Use só se for apontar uma ferramenta
gráfica e não houver outra opção.

### 3b. TCP Proxy (necessário para o Vercel, não para as migrations)

O Vercel está fora da rede do Railway, então a URL privada
(`postgres.railway.internal`) **não resolve lá**. Para a API, use o host público:

**Postgres → Settings → Networking → TCP Proxy** (ou `railway tcp-proxy create --port 5432`).
O host sai como `xxxxx.proxy.rlwy.net` e a porta é atribuída.

Essa URL é a que vai para a variável `NEXUS_DATABASE_URL` do Vercel — e ela **é um
segredo**. Configure pelo painel do Vercel, nunca por linha de comando com `echo`.

### 3c. Executando de dentro do Railway sem túnel

```sh
railway run --service postgres sh    # shell com as variáveis do serviço
```

Útil para conferir se a variável existe, sem imprimir o valor:

```sh
railway variables --service postgres | grep -o '^DATABASE_[A-Z_]*'   # só os nomes
```

**Nunca** rode `railway variables` sem filtro num terminal compartilhado: ele
imprime valores.

---

## 4. Executar (o comando único)

O instalador faz as três fases na ordem, com o privilégio mínimo de cada uma.

```sh
cd /caminho/para/Nexus

PGHOST=xxxxx.proxy.rlwy.net \
PGPORT=12345 \
PGDATABASE=railway \
PGSSLMODE=require \
  sh packages/database/scripts/production/install-production.sh
```

Ele pergunta, em sequência, com **eco desligado**:

1. senha do `postgres`
2. nova senha para `nexus_migrator` (mínimo 12 caracteres)
3. nova senha para `nexus_app` (mínimo 12 caracteres)
4. a senha do `nexus_migrator` de novo, para a fase 2

O que acontece com as senhas:

- o script gera localmente o **verificador SCRAM-SHA-256** e envia só ele; a
  senha em texto claro nunca vai para o banco, para o log nem para `pg_stat_activity`;
- nada é escrito em disco; o histórico do shell não recebe nada;
- ao fim, as variáveis são apagadas da memória do processo.

**Guarde as duas senhas num gerenciador de segredos antes de continuar.** A de
`nexus_app` é a que irá para o Vercel; sem ela, a API não sobe.

### Se preferir executar fase por fase

```sh
# Fase 1 (admin)
psql "$URL_ADMIN" -f packages/database/scripts/production/00_prepare.sql
# Fase 2 (migrator)
NEXUS_MIGRATION_DATABASE_URL="$URL_MIGRATOR" NEXUS_MIGRATE_ASSUME_YES=1 \
  sh packages/database/scripts/migrate.sh
# Fase 3 (migrator)
psql "$URL_MIGRATOR" -f packages/database/scripts/production/20_grant_runtime.sql
# Verificação
psql "$URL_MIGRATOR" -f packages/database/scripts/production/30_verify.sql
```

Nesse modo a senha fica na variável e a URL existe na sua máquina. É por isso que
o instalador é a opção recomendada.

---

## 5. Verificação das oito migrations e das tabelas

`30_verify.sql` já roda no fim do instalador. Para repetir depois, isoladamente:

```sh
PGPASSWORD="$(cat ~/.nexus-migrator)" PGUSER=nexus_migrator \
  psql -h xxxxx.proxy.rlwy.net -p 12345 -d railway -f .../30_verify.sql
```

Saída esperada — os números abaixo foram **medidos** num banco instalado por este
mesmo procedimento, não estimados:

| Verificação | Esperado | Medido |
|---|---|---|
| linhas no ledger | 8, versões 1–8 | 8 |
| tabelas no schema `nexus` | 27 | 27 |
| tabelas com `FORCE ROW LEVEL SECURITY` | 20 | 20 |
| tabelas com chave primária | 27 | 27 |
| policies de RLS | 49 | 49 |
| `owner_identity` | 1 linha, singleton, id `…0004` | igual |
| providers `test-free`/`test-paid` | **0** (são fixture de teste) | 0 |
| `record_deleted_entity` pertence a | `nexus_migrator` (exigência da 00008) | igual |
| `audit_tool_grant_change` pertence a | `nexus_audit_writer` (decisão da 00007) | igual |
| tabelas com `FALTA GRANT` para `nexus_app` | 0 | 0 |

As 8 migrations, na ordem do ledger:

```
1  00001_initial_schema.sql              schema, tipos, tabelas, RLS, seed do owner
2  00002_auth_security.sql               auth_login_state, revoked_sessions
3  00003_persistence_integrity.sql       integridade
4  00004_core_execution_hierarchy.sql    hierarquia de execução
5  00005_assistant_seed_parity.sql       assistants
6  00006_assistant_seed_vivy.sql         assistants
7  00007_tool_grants_and_preferences.sql tool_grants, audit, preferências (+papéis)
8  00008_owner_deletion_tombstone_guard.sql  guarda de tombstone
```

---

## 6. Teste da API publicada

### 6.1 Antes: apontar o Vercel para `nexus_app`

No painel do Vercel, projeto `nexus-server` → Settings → Environment Variables →
`NEXUS_DATABASE_URL` → editar (production):

```
postgresql://nexus_app:<SENHA>@<host do Tcp Proxy>:<porta>/railway?sslmode=require
```

`sslmode=require` **não é opcional**: o pool do `pg` não define `ssl` sozinho
(`packages/database/src/postgres/pool.ts`), e o proxy do Railway exige TLS.

Depois: **Redeploy** (mudar variável não reinicia a função já publicada).

### 6.2 Os três testes

Com cache-buster em cada URL (o CDN devolve resposta antiga se a URL se repete):

```sh
BASE=https://nexus-server-five.vercel.app
N=$(date +%s)

# 1. readiness — o único que prova schema, não só conexão
curl -s "$BASE/v1/ready?t=$N"
# esperado: {"status":"ready"}        200
# se 503: o schema não está lá (ou NEXUS_DATABASE_URL ainda é a antiga)

# 2. login com senha errada — prova que a tabela de auth existe
curl -s -X POST "$BASE/v1/auth/login?t=$N" \
     -H 'content-type: application/json' -d '{"password":"errada-de-proposito"}'
# esperado: 401 {"code":"UNAUTHORIZED"}      (500 / 42P01 = schema ausente)

# 3. login correto, e criar conversa com o token
TOKEN=$(curl -s -X POST "$BASE/v1/auth/login?t=$N" \
        -H 'content-type: application/json' \
        -d "{\"password\":\"$NEXUS_OWNER_PASSWORD\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -s -X POST "$BASE/v1/conversations?t=$N" \
     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"title":"Teste pos-migracao"}'
# esperado: 201 {"conversation":{"id":"...", ...}}
```

Resultados medidos localmente, num banco instalado por este procedimento e
acessado como `nexus_app` (não-superuser):

```
/v1/health                  200  {"status":"ok"}
/v1/ready                   200  {"status":"ready"}
/v1/auth/login (certa)      200  token emitido
/v1/assistants              200  YUI
/v1/conversations (POST)    201  conversa criada
/v1/conversations/:id       200
/v1/auth/logout             200  {"ok":true}
```

### 6.3 Cuidado com o bloqueio de login

`POST /v1/auth/login` **bloqueia por 15 minutos após 5 falhas**
(`auth_login_state.locked_until`). Não repita o teste de senha errada em loop.
Se travar:

```sql
DELETE FROM nexus.auth_login_state WHERE singleton = true;   -- como nexus_migrator
```

---

## 7. Diagnóstico

### `must be able to SET ROLE "nexus_audit_writer"` (na 00007)

A fase 1 não foi executada, ou foi executada sem o `GRANT ... WITH SET TRUE`.
Rode-a de novo; ela é idempotente. **Não** use superuser para contornar: aplica a
00007 como superuser deixaria as funções com o dono errado e a 00008 depende de
`record_deleted_entity` pertencer a `nexus_migrator`.

### `relation "nexus.auth_login_state" does not exist` na API

O schema não foi aplicado, ou o Vercel aponta para outro banco. Confirme qual
banco a API alcança:

```sh
curl -s "https://nexus-server-five.vercel.app/v1/ready?t=$(date +%s)"
```

Se der `503`, o `NEXUS_DATABASE_URL` do Vercel não chegou ao banco migrado.

### `not_ready` logo após migrar, com `ready` no psql

O Vercel guarda a variável por ambiente (production × preview) e não reinicia a
função sozinho. Confirme que a variável foi alterada em **production** e faça
redeploy.

### Ledger com menos de 8 linhas (meio migrado)

**Não reaproveite o banco.** Não rode `DROP SCHEMA` para recomeçar — isso destrói
dado e não trata a causa. Primeiro identifique onde parou:

```sql
SELECT version, filename FROM nexus_migrations.schema_migrations ORDER BY version;
```

Se parou em 00001 ou 00002, a causa mais provável é falha de permissão no meio de
um arquivo que roda em autocommit (essas duas não têm `BEGIN`/`COMMIT`; as demais
têm). Se o schema já tem objetos, a reaplicação falha em `already exists`.

Nesse caso a saída é uma instalação limpa num banco novo do Railway — **não**
destrutiva para o banco atual, que pode ser removido só depois de a nova API
estar validada. Me avise o ledger que aparecer e eu preparo o passo exato.

### `password authentication failed` na fase 1

A senha do `postgres` do Railway está em **Postgres → Variables** e é diferente da
senha que você usa para entrar no painel. Consulte-a lá; não a cole no chat.

---

## 8. O que ainda depende de você

| Item | Por quê |
|---|---|
| **Autorização** para tocar no banco real | combinado: não executo nada sem ela |
| **Host e porta do Tcp Proxy** | não são segredo, mas eu não os tenho |
| **Senha do `postgres`** | só você tem; é digitada no script, com eco desligado, e não passa por mim |
| **Nova senha do `nexus_app`** | você define no script; é a que irá para o Vercel |

Com esses quatro, o procedimento roda sem que nenhum segredo apareça no chat.

---

## 9. Garantias do que está aqui

Cada afirmação foi medida localmente, num cluster PostgreSQL com `scram-sha-256`
obrigatório (o mesmo modo de autenticação do Railway):

| Garantia | Como foi provada |
|---|---|
| as 3 fases rodam de ponta a ponta num banco virgem | `applied=8`, ledger 1–8 |
| idempotência | 2ª execução: `applied=0 skipped=8`, 0 erros nas fases 1 e 3 |
| `nexus_migrator` não é superuser | `pg_roles` mostra `rolsuper = f` |
| nenhuma fase 2/3 usa admin | o instalador só conecta como `nexus_migrator` |
| SCRAM gerado localmente autentica | login real com a senha; hash como senha é recusado |
| a senha não vaza em log | `grep` nos logs de sucesso e de falha: 0 ocorrências |
| RLS isola | `nexus_app` sem contexto: 0 conversas; com contexto: 1 |
| segundo owner é impossível | `CHECK` de singleton recusa a inserção |
| a API funciona como `nexus_app` | 200/200/200/201/200/200 acima |
| falha alta, sem mentir | senha errada → exit 1, sem fase 3, sem "CONCLUIDO" |
