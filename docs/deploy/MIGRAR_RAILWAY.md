# Migrar o PostgreSQL do Railway

Fecha o único item que falta para a API do Vercel funcionar. O código já está
publicado e correto; o banco é que está vazio.

## O estado medido (2026-11-12)

Contra `https://nexus-server-five.vercel.app`:

| Requisição | Resposta |
|---|---|
| `GET /v1/health` | `200 {"status":"ok"}` |
| `GET /v1/ready` | `200 {"status":"ready"}` — antes da correção, ver abaixo |
| `GET /v1/assistants` | `401 UNAUTHORIZED` |
| `POST /v1/auth/login` | `500 42P01 relation "nexus.auth_login_state" does not exist` |

O `42P01` é a evidência: a API alcança um PostgreSQL, mas o schema `nexus` não
existe nele. Nenhuma das 8 migrations foi aplicada.

### Por que `/v1/ready` dizia "ready"

`checkConnectivity()` fazia `SELECT 1`, que passa em qualquer PostgreSQL
alcançável. A sonda não distinguia "conectado" de "migrado". Corrigido no commit
`404f43e`: agora resolve `to_regclass('nexus.auth_login_state')` e responde

- `503` quando conecta mas o schema não existe;
- `200` somente quando o schema está lá.

Depois dessa correção, `/v1/ready` na produção **vai passar a responder 503** até
este runbook ser executado. Isso é o comportamento correto.

## Pré-requisitos

O papel que roda as migrations **não pode ser superuser** — é o que o Railway
oferece. Ele precisa de:

| Privilégio | Para quê |
|---|---|
| `CREATEROLE` | criar `nexus_audit_writer` (exigido pela 00007) |
| `USAGE`, `CREATE` no schema `nexus` | schema criado pela 00001 |
| `GRANT OPTION` nas tabelas do schema | delegar ao escritor de auditoria |

O superuser padrão do Railway (`postgres`) tem tudo isso. Use-o como
provisionador se não houver papel dedicado.

## Passo 1 — URL externa

O Vercel roda fora da rede do Railway, então a URL **privada**
(`postgres.railway.internal`) não resolve. Use a externa
(`*.proxy.rlwy.net`), que o Railway expõe em **Postgres → Variables →
`DATABASE_PUBLIC_URL`**.

Confirme que a URL tem `?sslmode=require` (ou `verify-full` com a CA). O pool do
`pg` não define `ssl` sozinho (ver `packages/database/src/postgres/pool.ts`); sem
o parâmetro a conexão sobe em texto claro e o proxy pode recusar.

## Passo 2 — Prelúdio de papéis (obrigatório)

**Medido:** rodar `migrate.sh` num banco virgem com um papel não-superuser falha
em `42P01`-adjacente:

```
psql:...:406: ERROR:  must be able to SET ROLE "nexus_audit_writer"
```

As migrations 00001–00006 são aplicadas nesse meio-tempo, então o banco fica
**meio migrado** — pior que vazio, porque dá a impressão de que funcionou. O
prelúdio abaixo, copiado da própria
`packages/database/migrations/00007_tool_grants_and_preferences.sql` (linhas
302–310), é o que faz a 00007 passar. Executado como provisionador, após a 00001
ter criado o schema:

```sql
-- 1. o escritor de auditoria (NOLOGIN: não é credencial de login)
CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- 2. ele precisa de CREATE no schema para receber a propriedade da função
GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer;

-- 3. o provisionador precisa poder ASSUMIR o escritor
GRANT nexus_audit_writer TO <provisionador> WITH SET TRUE, INHERIT TRUE;

-- 4. e precisa poder delegar sobre objetos de outro dono (GRANT OPTION)
GRANT USAGE, CREATE ON SCHEMA nexus TO <provisionador> WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA nexus TO <provisionador> WITH GRANT OPTION;
```

### Ordem que não funciona

Rodar o prelúdio **antes** da 00001 também falha, porque o schema ainda não
existe (`GRANT ... ON SCHEMA nexus` → `schema "nexus" does not exist`). O
`migrate.sh` aplica todos os arquivos numa passada só, não há gancho entre a
00006 e a 00007.

Duas saídas, ambas válidas:

- **(a) preferida** — aplicar 00001–00006, rodar o prelúdio, reexecutar. O
  ledger registra o que já entrou e o re-run aplica só a 00007 e a 00008.
- **(b)** rodar o prelúdio dentro do intervalo com o `migrate.sh` pausado.

Medido para (a), num cluster virgem com provisionador não-superuser:

```
1ª execução : ERROR: must be able to SET ROLE "nexus_audit_writer"
              (00001..00006 já aplicadas)
prelúdio    : OK
2ª execução : Done. applied=2 skipped=6
ledger      : 8 migrations: 1,2,3,4,5,6,7,8
```

## Passo 3 — Aplicar

```sh
NEXUS_MIGRATION_DATABASE_URL='postgresql://...@...proxy.rlwy.net:PORT/railway' \
NEXUS_MIGRATE_ASSUME_YES=1 \
  sh packages/database/scripts/migrate.sh
```

Saída esperada na primeira execução: `applied=8 skipped=0`. Na segunda (para
confirmar idempotência): `applied=0 skipped=8`.

`NEXUS_MIGRATION_DATABASE_URL` é deliberadamente diferente de
`NEXUS_DATABASE_URL`: quem aplica DDL precisa de mais privilégio do que a API,
que roda com o papel de menor privilégio. Não aponte as duas para o mesmo papel.

### Duas ressalvas reais do runner

1. **00001 e 00002 não são atômicas.** Não têm `BEGIN`/`COMMIT`, então o
   PostgreSQL as executa em autocommit: uma falha no meio deixa as instruções
   anteriores aplicadas, e o ledger não registra o arquivo. Uma re-execução
   então tenta recriar o que já existe. Se isso acontecer, o banco precisa de
   limpeza manual. Rode o primeiro passo olhando.
2. **O runner não roda `bootstrap.sql`.** As migrations criam o schema e as
   tabelas, mas quem cria `nexus_app` e `nexus_anonymous` e concede os GRANTs de
   runtime é `packages/database/tests/postgres/bootstrap.sql` — que é **fixture de
   teste**: tem `GRANT CONNECT ON DATABASE nexus_test` fixo e precisa ser
   adaptado (nome do banco e papéis) antes de servir para produção. Enquanto isso
   não for feito, a API conecta com o papel provisionador e funciona; a separação
   de privilégios fica pendente.

## Passo 4 — Verificar

Pela API publicada, com cache-buster (o CDN serve resposta antiga se a URL se
repete):

```
GET  /v1/ready                     -> 200 {"status":"ready"}   (só agora)
POST /v1/auth/login senha errada   -> 401 {"code":"UNAUTHORIZED"}   (não mais 500)
GET  /v1/assistants sem sessão     -> 401
```

O sinal decisivo é o login: `500 / 42P01` significa schema ausente;
`401 Invalid credentials` significa schema presente e auth funcionando.

## O que não foi feito daqui

Não tenho acesso ao console do Railway nem à senha do PostgreSQL, e não vou
inventar credencial. Faltam exatamente duas coisas:

1. o valor da URL externa (`DATABASE_PUBLIC_URL`) — só para executar o runner;
2. a confirmação de qual papel roda as migrations.

Tudo o mais está testado localmente: o prelúdio, a ordem, o re-run idempotente e
o comportamento da API contra o banco resultante (200/200/401/401).
