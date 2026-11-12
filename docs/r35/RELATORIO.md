# R35 — Fechamento da Fase 5.1 (G13): relatório de revisão

Ambiente: **PostgreSQL 17.11** (binários `@embedded-postgres/linux-x64@17.11.0-beta.19`), cluster
local em `127.0.0.1:55432`, banco `nexus_test` recriado do zero a cada execução.
Nenhum commit, push, merge ou publicação foi feito. HEAD inalterado em `1f84f1c`.

---

## 1. Diagnóstico do provisionamento (a parte que a premissa original errava)

### 1.1 `CREATEROLE` sozinho **não** permite `ALTER FUNCTION ... OWNER TO`

```
ERROR:  must be able to SET ROLE "writer"
```

Para transferir propriedade o executante precisa poder **assumir** o novo dono. `CREATEROLE`
permite criar/alterar papéis, não assumi-los.

### 1.2 A membresia automática do `CREATE ROLE` **não** resolve

O PG 16+ registra, ao criar um papel, uma membresia `criador → papel` com
`admin_option = true` — mas **`set_option = false`**:

| member | role | admin_option | inherit_option | set_option | grantor |
|---|---|---|---|---|---|
| prov_r35 | nexus_audit_writer | t | f | **f** | postgres |

Detalhe decisivo: se o papel foi criado **pelo superusuário de bootstrap**, o `grantor` é
`postgres`, não o provisionador. O provisionador não pode `SET ROLE` mesmo sendo `admin`.

**Solução verificada:** `GRANT nexus_audit_writer TO <provisionador> WITH SET TRUE` (feito por
quem tem ADMIN/`postgres`) produz uma segunda linha com `set_option = true` e `grantor = prov_r35`,
que é a que vale.

### 1.3 `ALTER FUNCTION ... OWNER TO` exige `CREATE` no schema **do novo dono**

Erro enganoso: `permission denied for schema nexus` — o problema é o privilégio do **novo dono**,
não do executante. Confirmado por controle:
- provisionador dono do schema + `CREATE` → falha;
- **novo dono com `CREATE`** no schema → funciona.

Por isso a migration concede `CREATE` a `nexus_audit_writer`, faz o `ALTER FUNCTION`, e
**revoga** o `CREATE` logo depois (o escritor só precisa de `INSERT`).

### 1.4 `ALTER ROLE ... NOSUPERUSER / NOCREATEDB / NOBYPASSRLS` exige privilégio que o provisionador não tem

```
ERROR:  permission denied to alter role
DETAIL:  Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.
```
`NOCREATEDB` exige `CREATEDB`; `NOBYPASSRLS` exige `BYPASSRLS`.

**Consequência de projeto:** a 00007 **não reafirma** atributos com `ALTER ROLE` — isso quebraria
justamente o cenário "sem superuser". Ela **cria com os atributos corretos** e, para papel
preexistente, **verifica e falha** com mensagem acionável (item 2).

### 1.5 `GRANT` sem `GRANT OPTION` falha **em silêncio**

```
WARNING:  no privileges were granted for "owner_identity"
```
A migration "passa" e o escritor fica sem `SELECT` — o erro só aparece na primeira auditoria, em
runtime. Isso **não é detectável por exit code**. Por isso o teste de provisionamento conta
`no privileges` explicitamente e trata > 0 como falha.

**Privilégios mínimos do provisionador (verificado):**
`CREATEROLE` + `USAGE`/`CREATE` no schema `nexus` + **`GRANT OPTION`** nos objetos que delega.
Nem SUPERUSER, nem BYPASSRLS, nem ownership amplo.

### 1.6 Sequência correta (documentada na seção 2.1 da migration)

1. `CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`
2. `GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer;`
3. `GRANT nexus_audit_writer TO <provisionador> WITH SET TRUE, INHERIT TRUE;`
4. `GRANT USAGE, CREATE ON SCHEMA nexus TO <provisionador> WITH GRANT OPTION;`
   `GRANT ALL ON ALL TABLES IN SCHEMA nexus TO <provisionador> WITH GRANT OPTION;`
5. aplicar a 00007 (faz o `ALTER FUNCTION ... OWNER TO`);
6. `REVOKE CREATE ON SCHEMA nexus FROM nexus_audit_writer;`

### 1.7 Limpeza de papéis de cluster (pedido explícito)

`nexus_audit_writer` é objeto de **cluster**; suas dependências vivem em **`pg_shdepend`, que é por
banco**. Achado concreto durante a limpeza:

```
ERROR:  role "nexus_audit_writer" cannot be dropped because some objects depend on it
DETAIL:  2 objects in database nexus_audit_writer_test ... (dois bancos diferentes)
```

`DROP OWNED BY` **só age no banco corrente**. Ordem correta (implementada em
`docs/r35/pg_cleanup.sh`):

1. derrubar os **bancos de teste** primeiro (leva `pg_shdepend` junto);
2. para cada banco restante, `DROP OWNED BY` conectado **àquele** banco;
3. só então `DROP ROLE`, com o resultado verificado.

Achado adicional: `DROP OWNED ... CASCADE` executado enquanto o papel era **dono** de
schema/tabela deixou entradas `deptype='a'` (ownership) em `pg_shdepend` apontando para objetos
cujo dono já havia sido trocado — entrada órfã que **nenhum SQL comum limpa**. A saída é derrubar
o banco que a contém. Está documentado no script para não ser redescoberto.

---

## 2. Papel preexistente: a migration não presume segurança

Cenários executados (`docs/r35/test_preexisting_role.sh`), cada um em banco novo:

| papel preexistente | resultado |
|---|---|
| `SUPERUSER` | aborta: `Role nexus_audit_writer has unsafe attributes (superuser=t, ...)` |
| `BYPASSRLS` | aborta: `... (bypassrls=t, ...)` |
| `LOGIN` | aborta: `... (login=t, ...)` |
| `CREATEDB` | aborta: `... (createdb=t, ...)` |
| `CREATEROLE` | aborta: `... (createrole=t, ...)` |
| membro de `pg_read_all_data` | membership **removida**, 0 residuais |
| `nexus_app` membro do escritor | membership **removida**; `pg_has_role=false` |
| seguro (`NOLOGIN NOSUPERUSER NOBYPASSRLS`) | aplica normalmente (idempotente) |

A mensagem de erro inclui o comando de correção e diz que **um superusuário** deve executá-lo uma
única vez. A migration não tenta corrigir atributos privilegiados sozinha.

---

## 3. Policy de auditoria — e porque `WITH CHECK (true)` saiu

```sql
CREATE POLICY tool_grant_audit_writer_insert ON nexus.tool_grant_audit
  FOR INSERT TO nexus_audit_writer WITH CHECK (
    nexus.current_owner_id() IS NOT NULL
    AND nexus.configured_owner_id() IS NOT NULL
    AND owner_id = nexus.current_owner_id()
    AND owner_id = nexus.configured_owner_id()
    AND actor_owner_id = owner_id
  );
```

Provas (`C2.*` no verificador):

- `C2.1` INSERT pelo trigger grava 1 evento;
- `C2.control` mesma linha, contexto correto → **aceita** (prova que a recusa é da policy);
- `C2.2/C2.3` owner divergente e actor divergente → recusados (`42501`);
- `C2.3b` **contexto ausente** → recusado;
- `C2.4` `nexus_app` → `permission denied for table tool_grant_audit`;
- `C2.4b` **discriminação da causa**: FK comprovadamente ativa (`23503`), `INSERT` do escritor
  comprovadamente presente, FORCE RLS comprovado, expressão da policy comprovadamente ≠ `true`;
- `C2.4c` **limite documentado**: SUPERUSER fura o RLS;
- `C2.5` sem `UPDATE`/`DELETE`/`TRUNCATE` na trilha.

### Análise honesta do `IS NOT NULL`

Ao sabotar a policy (remover as duas cláusulas), o teste **continua passando**. Motivo: `WITH
CHECK` exige `TRUE`, e `uuid = NULL` resulta `NULL` — já é violação. As cláusulas são **defesa em
profundidade**: protegem contra uma futura troca por `IS NOT DISTINCT FROM` (que devolve `TRUE`
para `NULL = NULL`) ou por `coalesce`. Está registrado como tal no código e no teste; **não** está
sendo vendido como a barreira que segura o caso.

### Discriminação FK × RLS

Teste com `owner_id` inexistente é barrado pela **FK antes da RLS** (ação de integridade não passa
pelo RLS) — não prova nada sobre a policy. Os testes de policy usam **owner real** e variam apenas
o GUC de contexto; a FK satisfaz e só a policy pode recusar.

---

## 4. Lifecycle dos grants

| operação | resultado |
|---|---|
| INSERT `status='revoked'` | rejeitado `42501` |
| INSERT `granted` | **1 evento** de auditoria |
| `granted → revoked` | **exatamente 1 evento** (`granted=1`, `revoked=1` no total) |
| `granted → granted` (só `updated_at`) | rejeitado `42501` (`Active tool grant is immutable...`) |
| `granted → granted` (só `created_at`) | rejeitado |
| `revoked → granted` | rejeitado (`Revoked tool grant is immutable`) |
| `revoked → revoked` | rejeitado |
| troca de `owner_id`/`assistant_id`/`tool_id`/`id` | rejeitado (`Tool grant scope is immutable`) |
| troca de `granted_by_owner_id`/`granted_at` | rejeitado (`Tool grant provenance is immutable`) |
| UPDATE sem mudança de status | rejeitado na auditoria (2ª barreira) |

Prova direta em transação:

```
NOTICE:  1) INSERT -> 1 evento(s)  [esperado 1]
NOTICE:  2) REVOKE -> total 2      [esperado 2]
NOTICE:     granted=1  revoked=1
NOTICE:  3) revoked -> granted rejeitado: t
NOTICE:  4) revoked -> revoked rejeitado: t
```

**Barreiras sobrepostas:** `granted → granted` é barrado pelo trigger de lifecycle **e** pelo de
auditoria. Sabotar apenas o lifecycle não falha o teste "aceito?" — por isso o teste `1c` verifica
a **mensagem** (`immutable`), garantindo que a barreira primária está ativa. Foi assim que a
sabotagem S1 passou a ser detectada.

---

## 5. Integridade de triggers, FKs, constraints e índices

Método: dois bancos no mesmo cluster — `nexus_ref_00006` (00001–00006) e `nexus_cmp_00007`
(00001–00007). Catálogo extraído e comparado (`docs/r35/test_integrity.sh`).

```
objetos no banco de referencia (00001-00006): 254
objetos no banco com 00007:                   296
linhas removidas/alteradas: 1 (cabecalho do diff) ; adicionadas: 43
OK   apenas adicoes (tabelas/policies novas da Fase 5.1)
OK   todas as 13 funcoes preexistentes identicas (corpo, SECURITY DEFINER, search_path)
== INTEGRIDADE PRESERVADA ==
```

Comparação direcionada:

```
FKs removidas ou alteradas?        NENHUMA   (50 em ref, 56 em cmp: +6 das tabelas novas)
triggers preexistentes alterados?  NENHUM
indices preexistentes alterados?   NENHUM
policies preexistentes alteradas?  NENHUMA
RLS preexistente alterado?         NENHUM
ACL de tabelas preexistentes?      IDENTICAS
ACL do schema?                     IDENTICAS
ACL de funcoes preexistentes?      IDENTICAS
ACL de tipos preexistentes?        IDENTICAS
```

### Triggers tombstone (definição real do catálogo)

| tabela | trigger | função | timing | evento | nível | condição | TG_ARGV |
|---|---|---|---|---|---|---|---|
| `assistant_memories` | `memories_tombstone` | `record_deleted_entity()` | AFTER | DELETE | ROW | — | `memory` |
| `conversations` | `conversations_tombstone` | `record_deleted_entity()` | AFTER | DELETE | ROW | — | `conversation` |
| `messages` | `messages_tombstone` | `record_deleted_entity()` | AFTER | DELETE | ROW | — | `message` |

Função: `SECURITY DEFINER`, `search_path=pg_catalog`, corpo idêntico à fonte em 00001 (comparado
inclusive por `md5(pg_get_functiondef())`).

---

## 6. Auditoria final da 00007

| requisito | estado | evidência |
|---|---|---|
| lifecycle só INSERT `granted` + UPDATE `granted→revoked` | OK | §4 |
| 1 evento por concessão e por revogação | OK | `granted=1 revoked=1` |
| `granted→granted`, inclusive só `updated_at` | rejeitado | `42501` `immutable` |
| grants revogados não reativam | rejeitado | `Revoked tool grant is immutable` |
| escopo e proveniência imutáveis | rejeitado | `scope/provenance is immutable` |
| `tool_grant_audit.grant_id` sem FK (intencional) | OK | só `owner_id` e `assistant_id` têm FK |
| RLS ENABLE + FORCE nas 3 tabelas | OK | `ENABLE=true FORCE=true` × 3 |
| policy exige owner e contexto coerentes | OK | §3 |
| `nexus_app` não assume o escritor | OK | `pg_has_role=false` |
| atributos do escritor seguros | OK | `login=f super=f bypassrls=f createdb=f createrole=f` |
| memberships do escritor | nenhuma | 0 linhas em `pg_auth_members` |
| SECURITY DEFINER com `search_path` seguro | OK | `search_path=pg_catalog`, dono `nexus_audit_writer` |
| permissões não ampliadas | OK | `owner_identity` = SELECT, `tool_grant_audit` = INSERT |
| enums sem `USAGE` para PUBLIC | OK | só `postgres`, `nexus_app`, `nexus_audit_writer` |

`nexus_app` **não** executa a `SECURITY DEFINER`: `has_function_privilege = false`.

---

## 7. Limite de segurança — SUPERUSER está fora da fronteira do RLS

Verificado em PG 17.11: com `ENABLE` + `FORCE` e **sem nenhuma policy de INSERT** para o dono, um
superusuário insere direto em `tool_grant_audit`, sem contexto. `FORCE` faz o RLS valer para o
**dono da tabela**, não para SUPERUSER/BYPASSRLS.

Isso é o modelo do PostgreSQL, **não um defeito da policy**, e não é corrigível dentro do RLS.
Consequências aceitas e documentadas na migration (seção 2, bloco "LIMITE DE SEGURANCA"):

- quem tem SUPERUSER pode forjar ou apagar auditoria;
- a trilha protege contra a **aplicação**, contra o dono do schema e contra papéis comuns;
- **a operação normal não precisa de SUPERUSER**: a gravação é feita por `nexus_audit_writer`
  (NOLOGIN, NOSUPERUSER, NOBYPASSRLS) via SECURITY DEFINER, e o provisionamento exige apenas
  `CREATEROLE` + `GRANT OPTION`;
- recomendação: SUPERUSER só em janela administrativa; `nexus_app` e `nexus_audit_writer` **nunca**
  com SUPERUSER/BYPASSRLS.

O teste `C2.4c` **fixa o limite como comportamento esperado**: se um dia o superusuário deixar de
furar o RLS, o teste falha e a documentação precisa ser revista.

---

## 8. Resultados dos testes

| execução | resultado |
|---|---|
| harness PG 17.11 (`run_pg17.sh`) | **17/17**, exit 0 |
| provisionamento sem superuser | **todas as provas passaram**, exit 0 |
| papel preexistente inseguro | **todos os cenários passaram**, exit 0 |
| integridade de catálogo | **INTEGRIDADE PRESERVADA**, exit 0 |
| `npm test` | **791 passed / 28 skipped** (819), 61 arquivos |
| `migrations.test.ts` | **14/14** |
| `npm run build` | exit 0 |
| `tsc --noEmit` (5 pacotes) | exit 0 |

### Sabotagens

| # | sabotagem | detectada por |
|---|---|---|
| S1 | `granted→granted` permitido (`RETURN NEW`) | teste 1c (mensagem `immutable`) |
| S4 | verificação de atributos removida | `test_preexisting_role.sh` (5 cenários) |
| S5 | remoção de memberships desativada | `test_preexisting_role.sh` (membership residual) |
| — | policy volta a `WITH CHECK (true)` | `C2.2` (owner divergente aceito) |

**S2 (`::text::` → CASE) não é sabotagem legítima:** é refatoração sem mudança de comportamento
observável. Um `CASE` que cobre os mesmos dois valores produz resultado idêntico; exigir que um
teste distinga as duas formas seria exigir que o teste lesse o código-fonte, não o comportamento.
Declarado aqui em vez de contado como "detectado".

---

## 9. Pendências e limitações (sem mascarar)

1. **`00003_persistence_integrity.sql` não roda como não-superuser.** Ela faz
   `INSERT INTO nexus.global_provider_preferences` sem contexto de `owner_id`, e a tabela tem
   `FORCE RLS` com policy de INSERT. Resultado: `new row violates row-level security policy`.
   É **defeito preexistente, fora do escopo autorizado** (proibido alterar 00001–00006).
   Por isso o teste de provisionamento aplica 00001–00006 como papel administrativo e a **00007**
   como `prov_r35`. O provisionamento real de uma instalação nova esbarraria nisso antes da 00007.
2. **Exclusão do owner com dados** continua `23503` / `tombstones_owner_id_fkey` (defeito de 00001,
   já registrado em R34).
3. **`assistant_id ON DELETE RESTRICT`** na trilha de auditoria: apagar um assistente com eventos
   é bloqueado. Decisão de modelo, não defeito.
4. **`verify-stage-5-rls.sql` bloco 9b** aceita `42501` **ou** `23514`; a distinção depende de qual
   trigger dispara primeiro.
5. **`verify_baseline` usa nome fixo** — colide se rodado em paralelo.
6. **`psql` é 16.2** (cliente) contra servidor 17.11. O tarball 17.11 não traz `psql`; o cliente
   anterior é compatível e todas as provas são de servidor. Declarado por transparência.
7. **S2 não é detectável por teste de comportamento** (ver §8).

---

## 10. Estado do repositório

```
HEAD: 1f84f1cc2a1dd9dacd7619b6183fcc4bec997f13
branch: arena/53ca4a3e-nexus
commits à frente de origin/main: 0
git diff --check: sem problemas
```

```
 M packages/assistant-profiles/src/catalog.ts
 M packages/database/scripts/test-postgres-integration.sh
 M packages/database/src/migrations.test.ts
 M packages/database/tests/postgres/bootstrap.sql
 M packages/tools/src/tools.test.ts
?? docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md
?? docs/r35/
?? packages/database/migrations/00007_tool_grants_and_preferences.sql
?? packages/database/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql
?? packages/database/tests/postgres/verify-stage-5-grants-lifecycle.sql
?? packages/database/tests/postgres/verify-stage-5-owner-deletion.sql
?? packages/database/tests/postgres/verify-stage-5-preferences.sql
?? packages/database/tests/postgres/verify-stage-5-rls.sql
```

**Nenhum commit, push, merge ou publicação.**

### MD5

| arquivo | MD5 | vs. baseline R34 |
|---|---|---|
| `packages/database/migrations/00007_tool_grants_and_preferences.sql` | `538fc52d7edfe2d9623319e694cd03cc` | mudou (`24a0f9f9…`) |
| `packages/database/tests/postgres/verify-stage-5-grants-lifecycle.sql` | `8c09b6b202d050a347c02cc113a3e9b8` | mudou (`828464bc…`) |
| `packages/database/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql` | `096ac9e5b6a84c768215ef25007e723e` | mudou (`88568276…`) |
| `packages/database/src/migrations.test.ts` | `164ca19a3a76eb93022906adb69ffad5` | mudou (`96d501fa…`) |
| `packages/database/tests/postgres/verify-stage-5-rls.sql` | `5a82cc6e46b12abda98cf86eadf556db` | igual |
| `packages/database/tests/postgres/verify-stage-5-owner-deletion.sql` | `a806a6924faeace940c8b1d3ed0f00ee` | igual |
| `packages/database/tests/postgres/verify-stage-5-preferences.sql` | `80586af9742b29ebfa183430f4975b42` | igual |
| `packages/database/tests/postgres/bootstrap.sql` | `4b20732d40d0722ec5a7fe93bc4fbfe0` | igual |
| `packages/database/scripts/test-postgres-integration.sh` | `8acbec04012c18936e309c958e30b472` | igual |
| `packages/assistant-profiles/src/catalog.ts` | `5f1898f9dfdc2542e0449d8b60c28178` | igual |
| `packages/tools/src/tools.test.ts` | `cadd01f736ae2abb896bf4870f83ab62` | igual |
| `docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md` | `b8bbb605b7f5a68985dd2b5917f6cb6c` | igual |

### Migrations 00001–00006 (imutáveis)

```
for f in .../0000[1-6]*.sql; do md5sum "$f"; done | md5sum
870d0bd9669b2d39e33101cff8b8dd62     <- idêntico ao baseline
```

Artefatos completos em `docs/r35/`:

- `01-modificados.diff` — diff dos 5 arquivos modificados (384 linhas)
- `02-novos.diff` — diff dos 7 arquivos novos (4780 linhas)
- `harness.log`, `provisionamento.log`, `papel-preexistente.log`, `integridade.log`
- `run_pg17.sh`, `test_provisioning.sh`, `test_preexisting_role.sh`, `test_integrity.sh`,
  `pg_cleanup.sh`
