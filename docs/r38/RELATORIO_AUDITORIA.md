# R38 — Auditoria independente da Fase 5.1 (G13)

**Escopo:** revisão independente das alterações finais da Fase 5.1, com verificação direta de catálogo,
revisão integral dos scripts e verificação de integridade dos verificadores.
**Ambiente:** PostgreSQL 17.11, cluster local `127.0.0.1:55432`, instalação limpa em banco `nexus_test`.
**Repo:** `HEAD 1f84f1c`, branch `arena/53ca4a3e-nexus`. Nada commitado, nada publicado.
**Migrations 00001–00006:** inalteradas (MD5 idênticos ao baseline — §5.6).
**00003:** não alterada (R38-c), conforme instrução.

> **Status:** os testes automatizados passam, mas a auditoria **encontrou e corrigiu quatro defeitos**
> que a execução anterior não expunha. Dois deles afetavam a *validade* das asserções (não o produto),
> um afetava a *segurança do provisionamento* e um era uma afirmação **falsa** no relatório anterior.
> Isso está detalhado em §6. A aprovação é condicionada ao que está em §7.

---

## 1. Separação dos papéis — verificação no catálogo

### 1.1 Atributos (evidência: `logs/catalogo-papeis.log`)

| papel | super | bypassrls | login | createrole | createdb | inherit |
|---|---|---|---|---|---|---|
| `nexus_migrator` | **f** | **f** | t | t | f | f |
| `nexus_app` | **f** | **f** | t | **f** | **f** | f |
| `nexus_anonymous` | f | f | f | f | f | f |
| `nexus_audit_writer` | **f** | **f** | **f** | f | f | t |
| `nexus_infra` (bootstrap) | **f** | **f** | t | t | t | t |

Todos os requisitos pedidos estão satisfeitos: `nexus_app` é `NOSUPERUSER`, `NOBYPASSRLS`, sem
`CREATEROLE` e sem `CREATEDB`; `nexus_audit_writer` é `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`.

`nexus_migrator` mantém `CREATEROLE` porque **é isso que aplica a 00007** (que executa
`CREATE ROLE nexus_audit_writer`). Não tem `CREATEDB` nem `BYPASSRLS`.

### 1.2 Memberships efetivas

```
nexus_infra    → nexus_migrator     admin=t  set=t  inherit=f
nexus_migrator → nexus_app          admin=t  set=t  inherit=f
nexus_migrator → nexus_anonymous    admin=t  set=t  inherit=f
nexus_migrator → nexus_audit_writer admin=t  set=f  inherit=f   (criada por CREATE ROLE)
nexus_migrator → nexus_audit_writer admin=f  set=t  inherit=f   (auto-concessao)
```

Duas memberships para o mesmo par é o esperado: o PostgreSQL 16+ não permite `ADMIN` e `SET` na
mesma linha quando `INHERIT` difere (§2).

### 1.3 O runtime não escala (medido por execução, não por leitura)

| tentativa como `nexus_app` | resultado |
|---|---|
| `SET ROLE nexus_audit_writer` | recusado — `permission denied to set role` |
| `SET ROLE nexus_migrator` | recusado — `permission denied to set role` |
| `CREATE ROLE x` | recusado — `permission denied to create role` |
| `CREATE TABLE nexus.y` / `public.y` | recusado — `permission denied for schema` |
| `ALTER TABLE` / `DROP POLICY` / `DISABLE RLS` | recusado — `must be owner of table` |
| `ALTER FUNCTION … OWNER TO` | recusado — `must be owner of function` |
| `CREATE DATABASE` | recusado — `permission denied to create database` |
| `GRANT SELECT ON nexus.messages TO nexus_anonymous` | **`WARNING: no privileges were granted`** — **sem efeito** (`has_table_privilege('nexus_anonymous', …, 'SELECT') = f`) |

`pg_has_role('nexus_app', '<qualquer papel>', 'SET')` = `f` para **todos** os papéis, inclusive
`nexus_audit_writer`, `nexus_migrator` e os `pg_*_all_data`. `nexus_app` tem `CREATE=f` e `USAGE=t`
em `nexus` e `public`; `CREATE DATABASE=f`, `TEMP=t`. Não é dono de nenhuma tabela, schema ou função.

**O caso do `GRANT` merece destaque** porque é a armadilha clássica: `GRANT` sem grant option **não
levanta erro**, só emite `WARNING`. Um teste que se baseie em exit code concluiria "permitido". A
verificação correta é de **efeito**, e o efeito é nulo.

### 1.4 A membership automática do PostgreSQL 16+ (medida, `logs/self-grant.log`)

Fatos estabelecidos executando o cenário, com `createrole_self_grant = ''` (default do cluster):

1. Quando um papel **não-superuser** com `CREATEROLE` executa `CREATE ROLE alvo`, o PostgreSQL cria
   **automaticamente** uma membership `criador → alvo` com `admin_option = true`,
   `set_option = false`, `grantor` registrado como o criador.
2. **`admin_option` não permite `SET ROLE`.** Provado: `SET ROLE sg_alvo` →
   `ERROR: permission denied to set role "sg_alvo"`.
3. O criador, por ter `ADMIN`, pode **conceder a si mesmo** uma segunda membership com
   `set_option = true` (`GRANT alvo TO criador WITH SET TRUE`). Depois disso `SET ROLE` funciona —
   medido na mesma sessão: `current_user = sg_alvo`.
4. Isso **independe** de `createrole_self_grant` estar definido.

**Não é via de escalada para o runtime**, por três razões independentes:

- `ADMIN OPTION` recai sobre o **criador do papel**, que é o provisionador — um papel que já é dono
  do schema. Ele não ganha nada que já não tivesse (dono pode `DROP`/`ALTER` tudo).
- `nexus_app` **nunca** aparece nessa cadeia: não é membro de nada e não pode `SET ROLE` em nada.
  Isso é verificado explicitamente em §D2 do `verify-stage-5-grants-lifecycle.sql` e comprovado por
  sabotagem (§4).
- A membership de `nexus_migrator` sobre `nexus_app`/`nexus_anonymous`/`nexus_audit_writer` existe
  **apenas** com `set_option=true` e `inherit_option=false` — o migrator pode assumir os papéis, mas
  **não herda** seus privilégios (`pg_has_role(…, 'USAGE') = false`).

**Achado de segurança corrigido (§6, D-3):** a membership `nexus_infra → nexus_migrator` foi criada
inicialmente **sem `INHERIT FALSE`** e, como `nexus_infra` tem `rolinherit = t`, ele **herdava os
poderes de dono do schema**. Comprovado por execução: `CREATE TABLE nexus.tabela_infra(i int)`
**teve sucesso**. Corrigido para `WITH SET TRUE, INHERIT FALSE`; a nova prova negativa é executada
pelo próprio script (tenta o DDL e exige que falhe).

---

## 2. Scripts e verificadores

### 2.1 Ordem real de execução (`scripts/install_clean.sh`)

```
 0. PRÉ-REQUISITO DE PLATAFORMA — postgres cria nexus_infra (CREATEROLE+CREATEDB, NOSUPERUSER)
 1. cleanup de papéis; DROP DATABASE (por nexus_infra)
 2. nexus_infra cria nexus_migrator; auto-concessão SET; CREATE DATABASE OWNER
 3. ALTER SCHEMA public OWNER TO nexus_migrator  (pelo próprio migrator)
 4. 00001 → 00002 → legacy-stage-2a (seed) → 00003 → verify-stage-2b
    → 00004 → 00005 → 00006                       (todos com prelúdio de contexto RLS)
 5. CREATE ROLE nexus_audit_writer (pelo migrator, CREATEROLE)
 6. GRANT nexus_audit_writer TO nexus_migrator WITH SET TRUE
 7. GRANT USAGE,CREATE ON SCHEMA nexus TO nexus_audit_writer  (pelo DONO do schema)
 8. 00007 → verify-assistant-seed-parity → bootstrap.sql
 9. GRANT SET nos papéis de runtime (auto-concessão pelo migrator)
10. integration.sql (como nexus_app)
11. verify-stage-5-cascade-without-delete-policy     ← precisa de Fase 5 vazia
12. verify-stage-5-grants-lifecycle → -preferences → -owner-deletion
13. verify-stage-5-rls (como nexus_app)
```

A ordem do passo 11 é **obrigatória e não óbvia**: `tool_grant_audit` é *append-only* (só possui
policies de `SELECT` e `INSERT`) e `DELETE` sobre ela afeta 0 linhas **sem erro**, inclusive para o
dono da tabela sob `FORCE RLS`. Depois que qualquer verificador escreve na trilha, o teste de cascata
— que exige as tabelas da Fase 5 vazias — **não tem como rodar naquele banco**. Não existe "limpar
entre cenários"; existe rodar o cascade antes. Isso está documentado no script.

### 2.2 Mascaramento de falhas — varredura

| verificação | resultado |
|---|---|
| `\|\| true` | **0 ocorrências** |
| `2>/dev/null` em etapa com asserção | **0** (as 4 restantes foram removidas; ver D-1) |
| `\$\| sed` em asserção | **corrigido** — ver D-2 |
| `-q` em asserção | apenas silencia eco; status é sempre checado via `rc=$?` |

**D-2 (defeito real encontrado e corrigido):** três asserções usavam
`$PSQL … <<'SQL' 2>&1 | sed 's/^/   /'` e depois checavam `[ $? -eq 0 ]`. Em shell, `$?` após um
pipe é o status do **último** comando do pipe (`sed`), que é sempre 0. **Essas asserções passavam
independentemente de o SQL ter falhado.** Provado: `false | sed 's/^/   /'; echo $?` → `0`.
Corrigido capturando a saída em variável e testando `rc` do `psql` (`); rc=$?; echo "$out" | sed …`).

**D-1 (defeito real encontrado e corrigido):** a limpeza de papéis usava
`/tmp/pg_cleanup.sh … >/dev/null 2>&1`. Ela falhava (papel ainda dono de banco residual de
experimento anterior) e o script seguia, para falhar depois em `CREATE ROLE … already exists` com
mensagem enganosa. Agora a saída vai para `logs/../cleanup.log`, o status é checado e a presença de
`AINDA PENDENTE` aborta com diagnóstico.

### 2.3 Testes que dependem acidentalmente de SUPERUSER — auditoria

Encontrados e corrigidos **três** pontos em que a asserção só passava porque o runner era superuser.
Nenhum deles foi "flexibilizado"; em cada caso o teste passou a afirmar o **comportamento real de
produção**.

| local | antes (exigia superuser) | depois (correto nos dois papéis) |
|---|---|---|
| `grants-lifecycle` C2.4c | `SET LOCAL ROLE postgres` + INSERT, falhando se o INSERT falhasse | roda **condicionalmente**: sob superuser prova o bypass; sob não-superuser registra que a prova não é executável ali. Se o runner *for* superuser e o INSERT falhar, **quebra de propósito** |
| `grants-lifecycle` C2.4b | exigia `23503` sempre | aceita `23503` **ou** `42501`, validando a origem de cada um (constraint `tombstones_owner_id_fkey` / mensagem citando `tombstones`) |
| `owner-deletion` §3 | exigia `23503` sempre | idem; sob não-superuser o SQLSTATE real é `42501` |

**Por que o comportamento muda:** sob superuser a RLS é ignorada e o trigger chega a violar a FK
(`23503`). Sob não-superuser — **o caso de produção** — a RLS de `tombstones` barra antes (`42501`).
O defeito (não conseguir excluir o owner com dados) é real nos dois casos; o SQLSTATE muda.

### 2.4 Contexto RLS

Configurado por **prelúdio de sessão** (`set_config(…, false)`) no runner, e por `set_config(…, true)`
nos blocos transacionais dos próprios verificadores. Migrations e seed recebem o prelúdio via
`run_with_ctx`; os verificadores de dados definem o seu próprio (idempotente; sob superuser é inócuo).

### 2.5 Banco limpo e resíduos

Cada execução recria `nexus_test` do zero. A limpeza de papéis identifica dependências **por banco**
antes de agir (nunca `DROP OWNED` cego). Encontrado resíduo real: seis bancos de experimentos
anteriores (`nexus_diag`, `nexus_prod_sim`, `nexus_ctl_nocontext`, `nexus_hyp_context`,
`nexus_ref_00006`, `nexus_cmp_00007`) dos quais `nexus_migrator` era dono — impediam o `DROP ROLE`.
Removidos explicitamente (§6, D-4).

### 2.6 Semântica enfraquecida? — veredito

**Nenhum verificador teve sua semântica enfraquecida para acomodar o provisionador.** As quatro
mudanças em verificadores são:

1. **Allowlist de enums** — antes exigia literalmente `postgres` como dono; agora isenta o
   **verdadeiro dono** do tipo (`a.grantee <> t.typowner`). Isso **não afrouxa**: qualquer papel
   estranho continua sendo detectado, e a checagem exaustiva de `PUBLIC` (§C1.2, linhas ~278-291)
   permanece intacta e é a que realmente cobre `PUBLIC`.
2. **D2 (membership do writer)** — antes exigia zero membros além de `postgres`; agora isenta o
   **próprio executante**, que é quem precisa de `SET ROLE` para o `ALTER FUNCTION … OWNER TO`. A
   verificação explícita de que `nexus_app` não é membro **permanece** e é redundante de propósito.
3. **`owner-deletion` / `cascade`** — passaram a **definir contexto RLS** para enxergar as linhas.
   Antes, sem contexto, viam zero linhas e acusavam "faltam seeds" (falso negativo). Isso **fortalece**
   o teste: ele agora mede o que diz medir.
4. **`cascade` §5** — a premissa "sou `postgres`" virou "sou **dono da tabela**", que é o que
   realmente importa (poder de `DROP POLICY` e escrita não barrada). Semanticamente equivalente e
   independente do nome do papel.

---

## 3. Instalação e runtime

| verificação | resultado | log |
|---|---|---|
| instalação completa sem SUPERUSER | **exit 0** (29 asserções `OK`, 0 `FALHA`) | `logs/instalacao.log` |
| 7 migrations aplicadas | 00001…00007 **OK** | idem |
| `bootstrap.sql` | **OK** | idem |
| etapas verificadas da instalação | **9/9 OK**, 0 falhas: `verify-stage-2b`, `verify-assistant-seed-parity`, `bootstrap.sql`, `integration.sql`, e os **5 verificadores da Fase 5** (`cascade`, `grants-lifecycle`, `preferences`, `owner-deletion`, `rls`) | idem |
| testes de integração como `nexus_app` | **21/21** (`pool` 4 + `repositories` 17) | `logs/vitest.log` |
| isolamento do runtime | **28/28 provas** | `logs/isolamento.log` |
| sabotagem dos verificadores | **5/5 detectadas** | `logs/sabotagem.log` |
| catálogo | 27 tabelas, 20 `FORCE RLS`, 49 policies, 56 FKs | §3.3 |
| segredos nos logs | **nenhum** (0 URLs de conexão, 0 padrões de credencial) | §5.5 |

### 3.1 Auditoria: exatamente um evento por concessão e por revogação

```
AUD antes            = 5
INSERT tool_grants   → AUD apos grant  = 6     (+1)
UPDATE status=revoked→ AUD apos revoke = 7     (+1)
AUD eventos          = granted,revoked
AUD total p/ o grant = 2
```

`UPDATE` sem `revoked_at`/`revoked_by_owner_id` é rejeitado com diagnóstico explícito
("Revocation requires both …"), o que é o comportamento pretendido.

### 3.2 RLS continua efetiva

`verify-stage-5-rls.sql` roda **como `nexus_app`** e passa. No isolamento: leitura sem contexto = 0,
com contexto do owner = 5, com contexto de outro owner = 0, escrita com owner forjado = recusada.

### 3.3 Catálogo final

`tabelas=27 · FORCE RLS=20 · policies=49 · FKs=56`; dono de `audit_tool_grant_change()` =
`nexus_audit_writer`, `prosecdef=t`, `proconfig=search_path=pg_catalog`.

---

## 4. Integridade dos verificadores — prova por sabotagem

Executado em banco virgem, sabotando o catálogo e rodando o bloco isolado (`logs/sabotagem.log`):

| sabotagem | detectada por |
|---|---|
| `USAGE` de enum para papel inesperado | `Unexpected privilege on Phase 5 enums` |
| `USAGE` de enum para `PUBLIC` | `Type … still grants USAGE to PUBLIC` |
| papel comum membro de `nexus_audit_writer` | `Unexpected member(s) of nexus_audit_writer` |
| **`nexus_app` membro de `nexus_audit_writer`** | `Unexpected member(s) … nexus_app` |
| `nexus_audit_writer` herda `nexus_app` | `nexus_audit_writer inherits privileges from: nexus_app` |

Resultado: **0 não detectadas**. Para `owner-deletion`, prova por mutação: um `DELETE` forçado a
falhar com `42P01` é **rejeitado** pela asserção (`NOT IN ('23503','42501')`), confirmando que ela não
aceita qualquer erro.

---

## 5. Entrega

### 5.1 Arquivos alterados nesta etapa (R38)

Apenas **três verificadores**. Nenhuma migration, nenhum runtime, nenhum `bootstrap.sql`,
nenhum `test-postgres-integration.sh`.

| arquivo | MD5 antes (R37) | MD5 depois | diff |
|---|---|---|---|
| `verify-stage-5-grants-lifecycle.sql` | `8c09b6b202d050a347c02cc113a3e9b8` | `278c6f65dd9cf1bbba7bb54458919661` | `diffs/…grants-lifecycle.diff` (187 linhas) |
| `verify-stage-5-owner-deletion.sql` | `a806a6924faeace940c8b1d3ed0f00ee` | `f660333c38c483292ddcde7c50c5db2f` | `diffs/…owner-deletion.diff` (57 linhas) |
| `verify-stage-5-cascade-without-delete-policy.sql` | `096ac9e5b6a84c768215ef25007e723e` | `b3ae4bad91d0a95921413d78e722a05c` | `diffs/…cascade.diff` (49 linhas) |

A base de comparação foi reconstruída aplicando `docs/r35/02-novos.diff` em árvore vazia; os MD5
obtidos coincidem com os registrados no R37, o que valida a comparação.

### 5.2 Arquivos novos (artefatos de auditoria)

```
docs/r38/RELATORIO_AUDITORIA.md          este relatório
docs/r38/diffs/*.diff                    3 diffs completos
docs/r38/scripts/install_clean.sh        instalação limpa executável (auditável)
docs/r38/scripts/test_runtime_isolation.sh
docs/r38/scripts/exp_selfgrant.sh        prova da membership automática
docs/r38/scripts/sabotagem_r38.sh        prova de integridade dos verificadores
docs/r38/scripts/pg_cleanup.sh
docs/r38/logs/instalacao.log             instalação completa
docs/r38/logs/isolamento.log             28 provas
docs/r38/logs/sabotagem.log              5/5
docs/r38/logs/vitest.log                 21/21
docs/r38/logs/catalogo-papeis.log        atributos e memberships
docs/r38/logs/self-grant.log             fatos medidos do PG 16+
```

### 5.3 `git status --short`

```
 M packages/assistant-profiles/src/catalog.ts
 M packages/database/scripts/test-postgres-integration.sh
 M packages/database/src/migrations.test.ts
 M packages/database/tests/postgres/bootstrap.sql
 M packages/tools/src/tools.test.ts
?? docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md
?? docs/r35/
?? docs/r38/
?? packages/database/migrations/00007_tool_grants_and_preferences.sql
?? packages/database/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql
?? packages/database/tests/postgres/verify-stage-5-grants-lifecycle.sql
?? packages/database/tests/postgres/verify-stage-5-owner-deletion.sql
?? packages/database/tests/postgres/verify-stage-5-preferences.sql
?? packages/database/tests/postgres/verify-stage-5-rls.sql
```

As 5 entradas ` M` e `docs/FASE_5_G13_…md` e `docs/r35/` são **das fases anteriores**, preservadas
(R34). Nenhum commit, push, merge ou publicação foi feito.

### 5.4 `git diff --check` e HEAD

```
git diff --check  → (limpo)
HEAD              → 1f84f1c
```

### 5.5 Segredos

Varredura em todos os logs e scripts publicados: **0** ocorrências de `password`, `senha`, `secret`,
`api_key`, chave privada ou token JWT; **0** URLs de conexão (`://`). Os scripts usam apenas
`-h 127.0.0.1 -p 55432 -U <papel>`, sem senha (trust local do cluster de teste).

### 5.6 Migrations 00001–00006 — idênticas ao baseline

```
d1a819f6e80285d4ca09a4cbcef403fa  00001_initial_schema.sql
f0c65c8f03a9a3a8328bc74f856a9447  00002_auth_security.sql
f7be36f25e4cb55d7c943797e68e521b  00003_persistence_integrity.sql
1de2a59512f908b489d956c52da38d22  00004_core_execution_hierarchy.sql
428cfbd44bbf67d32b4f6b6e81ff9d60  00005_assistant_seed_parity.sql
d5556ff1745b33c317c0ba8b8d4930f5  00006_assistant_seed_vivy.sql
```

Todos coincidem com os MD5 registrados no R37. **00003 não foi alterada** nesta etapa nem em nenhuma
anterior.

---

## 6. Defeitos encontrados nesta auditoria

| # | gravidade | descrição | estado |
|---|---|---|---|
| **D-1** | média | limpeza de papéis com `>/dev/null 2>&1` mascarava falha; script seguia e falhava depois com mensagem enganosa | corrigido |
| **D-2** | **alta** | três asserções checavam `$?` após um pipe → **sempre passavam**, mesmo com SQL falhando | corrigido |
| **D-3** | **alta** | `nexus_infra` herdava os poderes de `nexus_migrator` (`INHERIT` default `t`); comprovado `CREATE TABLE` bem-sucedido | corrigido + prova negativa no script |
| **D-4** | baixa | 6 bancos residuais de experimentos impediam `DROP ROLE` | removidos |
| **D-5** | **honestidade** | o relatório anterior afirmava "sem SUPERUSER em nenhuma etapa" quando o script usava `postgres` em 11 pontos, inclusive `GRANT` e `DELETE` | corrigido: **1 de 20** chamadas usa superuser, e é o pré-requisito de plataforma (§7.1) |

**D-5 é o mais importante para a confiança do resultado.** A afirmação anterior era falsa. O script
agora executa toda a instalação como `nexus_infra` (bootstrap) e `nexus_migrator` (migrations), com
**uma única** invocação como `postgres` — a criação do primeiro papel, que nenhum papel inexistente
pode fazer a si mesmo. A mensagem final do script foi mantida, mas agora é verdadeira no sentido
preciso descrito em §7.1.

---

## 7. Riscos e limitações remanescentes

### 7.1 Pré-requisito de plataforma (não é bypass da instalação)

Criar o **primeiro** papel do cluster é um ato que exige `CREATEROLE`, e não existe papel do projeto
que o possua antes de existir. Em Neon isso é o *owner* entregue pelo provedor no console. No
experimento, é o superusuário local criando **apenas**:
`nexus_infra LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS`. Nenhum DDL de schema, nenhuma
migration, nenhum dado e nenhum `GRANT` de tabela passam por ele.

### 7.2 Memberships com `ADMIN OPTION`

`nexus_migrator` detém `ADMIN` sobre os papéis que criou, e `nexus_infra` sobre `nexus_migrator`.
É inerente ao `CREATE ROLE` do PG 16+ e **não é escalada** (§1.4), mas reduz a defesa em profundidade:
comprometer o provisionador equivale a comprometer os papéis. *Mitigação futura:* criar os papéis de
runtime com um papel dedicado diferente do de migrations.

### 7.3 SUPERUSER ainda pode forjar a trilha de auditoria

Limite do PostgreSQL, já documentado no R37. `C2.4c` prova o bypass quando o runner é superuser e
**registra a impossibilidade** quando não é — sem falso negativo.

### 7.4 Exclusão do owner com dados falha (defeito do produto)

`23503` (superuser) / `42501` (produção). Comportamento correto e documentado; não é regressão desta
etapa. Continua sendo limitação aberta do produto.

### 7.5 `bootstrap.sql` hardcoda `current_database() = 'nexus_test'`

Impede instalar em banco com outro nome (encontrado ao tentar `nexus_sabotagem`). Mudança mínima
seria parametrizar o nome por `psql -v`; **não aplicada** por estar fora do escopo autorizado.

### 7.6 `tool_grant_audit` é append-only sem caminho de expurgo

Não há `DELETE` possível nem para o dono. Isso é *feature* de auditoria, mas significa que
**qualquer** teste que exija tabela vazia precisa de banco novo. Está documentado no script; é uma
restrição de operação de teste, não do produto.

### 7.7 Não há configuração de produção no repositório

Ver §8. Nada foi criado.

---

## 8. O que falta para produção (documentado, **não implementado**)

### 8.1 Credenciais necessárias

| credencial | papel PG | atributos | uso |
|---|---|---|---|
| **migrations** | `nexus_migrator` | `LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOINHERIT` | aplica 00001–00007; dono do schema `nexus`; roda **uma vez por deploy**, em job separado |
| **runtime** | `nexus_app` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT` | serve a aplicação; única credencial hoje usada (`NEXUS_DATABASE_URL`) |
| **auditoria** | `nexus_audit_writer` | `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB` | **não tem credencial**; só existe como dono de `audit_tool_grant_change()` (SECURITY DEFINER). Criado pela 00007 |
| **bootstrap** | `nexus_infra` | `LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS` | **só no provisionamento inicial**; criar `nexus_migrator`/banco. Não usar em runtime |

Nenhuma delas deve ser a mesma. `nexus_audit_writer` **não recebe senha** — é `NOLOGIN` por desenho.

### 8.2 Arquivos/configurações que precisam ser criados (fora do escopo desta etapa)

1. `packages/database/scripts/migrate.ts` (ou equivalente) — runner de migrations com o **prelúdio
   de contexto RLS** obrigatório; hoje o único agente é `test-postgres-integration.sh`, que é de teste.
2. Definição das variáveis de ambiente separadas (`NEXUS_MIGRATION_DATABASE_URL` vs
   `NEXUS_DATABASE_URL`) e do job de deploy que usa a primeira **antes** de promover a segunda.
3. Provisionamento de `nexus_audit_writer` em produção fora da 00007 (ou aceitar que a 00007 o cria,
   o que exige `CREATEROLE` no papel de migrations).
4. Documentação do procedimento de bootstrap inicial (`nexus_infra` → `nexus_migrator`), com o
   `INHERIT FALSE` explícito.
5. Configuração Neon/Vercel — **não inventada aqui**; não há informação suficiente no repositório.

---

## 9. Recomendação técnica final

**Aprovar a Fase 5.1 com ressalvas registradas**, condicionada a:

1. Aceitar que o fluxo de instalação exige **um** ato de nível de cluster (criar o primeiro papel),
   documentado em §7.1 — é pré-requisito de plataforma, não dependência de privilégio na instalação.
2. Reconhecer `D-2` e `D-3` como **defeitos reais corrigidos** — não eram falsos positivos de
   auditoria: `D-2` fazia asserções passarem sempre e `D-3` dava ao provisionador poder de DDL direto
   que ele não deveria ter.
3. Manter as limitações de §7.3–§7.6 como dívidas conhecidas, sem tratá-las como falhas desta etapa.

**O que sustenta a recomendação** não é a contagem de testes verdes, e sim: (a) a instalação foi
executada **sem superusuário** no fluxo de migrations; (b) o isolamento do runtime foi provado por
**execução** de 28 tentativas, incluindo a armadilha do `GRANT` sem efeito; (c) os verificadores
foram submetidos a **sabotagem** e detectaram 5/5 — inclusive os casos que eu havia mudado; (d) o
único ponto que ainda fala como superusuário está isolado, documentado e é logicamente inevitável.

**Não aprovo** a Fase 5.2 nem qualquer implementação de produção: elas exigem os itens de §8, que
não foram autorizados.
