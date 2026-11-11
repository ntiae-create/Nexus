# R41 — Diagnóstico da falha em `migrations.test.ts`

**Arquivo:** `packages/database/src/migrations.test.ts:334`
**Teste:** `keeps Phase 5 grants isolated by owner_id and audited append-only`
**Resultado:** 1 falha / 14 testes neste arquivo; independente das alterações do R41 (o teste não
lê `install_clean.sh` nem `pg_cleanup.sh`).

```
AssertionError: expected '\set ON_ERROR_STOP on\n-- Fase 5 (G13…' to contain
                'err_state IS DISTINCT FROM \'23503\''
```

---

## 1. Correção de um erro do relatório R40

O R40 §10 afirmou que a string `err_state IS DISTINCT FROM '23503'` "não existe nesse arquivo
(`grep -c` = 0 para `err_state` e para `23503`)" e atribuiu a falha à `00007_tool_grants_and_preferences.sql`.

**As duas afirmações estão erradas:**

- o arquivo lido pela asserção **não é** `00007`, é `tests/postgres/verify-stage-5-owner-deletion.sql`
  (linhas 328-333 do teste);
- esse verificador **tem** `err_state` (7 ocorrências) e **tem** `23503` (3 ocorrências).

A asserção falha porque exige uma **string exata** que não existe no arquivo — não porque o arquivo
não trate do assunto.

---

## 2. O contrato que o teste tenta garantir

O bloco verifica que o verificador `verify-stage-5-owner-deletion.sql`:

1. **registra** o SQLSTATE real da tentativa de `DELETE` do owner (via `GET STACKED DIAGNOSTICS`);
2. **afirma** que a exclusão falhou por um mecanismo de *tombstone*, não por erro genérico;
3. mantém as demais garantias (rollback, contagem de tombstones, limpeza declarada como contorno).

O objeto do contrato é: **"a exclusão do owner falha, e falha pelo mecanismo de tombstone"**.

---

## 3. A/B — o teste está desatualizado ou a migration perdeu proteção?

### Resposta: **A — o teste está desatualizado.** A proteção existe e é mais específica.

**Evidência 1 — a mudança foi deliberada e está registrada.**
`docs/r38/diffs/verify-stage-5-owner-deletion.diff` mostra a alteração exata:

```diff
-  IF err_state IS DISTINCT FROM '23503' THEN
-    RAISE EXCEPTION 'Expected SQLSTATE 23503 (foreign_key_violation), got %: %', err_state, err_message;
+  IF err_state NOT IN ('23503', '42501') THEN
+    RAISE EXCEPTION 'Expected SQLSTATE 23503 (FK) or 42501 (RLS on tombstones), got %: %', ...
   END IF;
-  IF err_constraint IS DISTINCT FROM 'tombstones_owner_id_fkey' THEN
+  IF err_state = '23503' AND err_constraint IS DISTINCT FROM 'tombstones_owner_id_fkey' THEN
     RAISE EXCEPTION 'Expected constraint tombstones_owner_id_fkey, got %', ...
   END IF;
+  IF err_state = '42501' AND err_message NOT LIKE '%tombstones%' THEN
+    RAISE EXCEPTION 'RLS rejection did not come from the tombstones table: %', err_message;
+  END IF;
```

O verificador **não** afrouxou para "qualquer erro": ele passou a aceitar **dois SQLSTATEs
específicos** e a validar a **origem** em cada caso (constraint `tombstones_owner_id_fkey` para
23503; mensagem contendo `tombstones` para 42501).

**Evidência 2 — medição empírica do SQLSTATE real.**

Sonda `GET STACKED DIAGNOSTICS` executada em `nexus_test` **completamente instalado**
(cluster descartável, PG 17.11):

| runner | SQLSTATE | constraint | mensagem |
|---|---|---|---|
| `postgres` (superuser) | **42501** | — | `new row violates row-level security policy for table "tombstones"` |
| `nexus_migrator` | **42501** | — | `new row violates row-level security policy for table "tombstones"` |
| `nexus_app` | **42501** | — | `permission denied for table owner_identity` |

**O 23503 não ocorre em nenhum dos casos.** O SQLSTATE real é sempre 42501.

**Evidência 3 — por que o 23503 nunca ocorre, inclusive como superuser.**

```
tombstones:                    relrowsecurity=t, relforcerowsecurity=t   <- FORCE RLS
trigger record_deleted_entity: prosecdef=t, dono=nexus_migrator          <- SECURITY DEFINER
policies em tombstones:        tombstones_owner_select (SELECT), tombstones_trigger_insert (INSERT)
postgres:     rolsuper=t, rolbypassrls=t
nexus_migrator: rolsuper=f, rolbypassrls=f
```

O mecanismo foi isolado em teste controlado:

| caminho | resultado |
|---|---|
| `INSERT` direto como `postgres` (superuser + `bypassrls`) | **passa** — superuser ignora RLS |
| `INSERT` dentro de função `SECURITY DEFINER` cujo dono é papel **sem** `bypassrls` | **`permission denied for table`** |

O `INSERT` em `tombstones` **não** é feito pelo runner: é feito **dentro do trigger**, que é
`SECURITY DEFINER` e portanto executa com os privilégios do **seu dono — `nexus_migrator`**, um papel
comum (`rolsuper=f, rolbypassrls=f`). A policy FORCE RLS se aplica a ele. A rejeição acontece **na
policy**, antes de a FK `tombstones_owner_id_fkey` ser avaliada — **o 23503 é inalcançável por
construção**, para qualquer runner.

Isto confirma que a asserção antiga (`err_state IS DISTINCT FROM '23503'`) exigia um caminho de
execução que este schema não permite.

**Evidência 3b — o comentário do verificador está factualmente errado em dois pontos.**

Ele afirma:

> * runner SUPERUSER: ignora RLS; … viola `tombstones_owner_id_fkey` -> 23503.
> * o trigger é SECURITY DEFINER com dono `postgres`

Medido: (a) o runner superuser também recebe **42501**, porque o `INSERT` ocorre dentro do trigger,
não no runner; (b) o dono real do trigger é **`nexus_migrator`**, não `postgres`
(`pg_proc.proowner`).

O raciocínio geral — "o SQLSTATE depende do caminho" — está certo, mas a conclusão de que o 23503
ocorre com runner superuser **não se sustenta**. A justificativa correta para o `NOT IN (...)`
é mais forte que a registrada: **só 42501 é possível**.

## 4. Existe UMA única divergência

Varredura automática de **todas as 13 asserções** sobre `ownerDeletion` no teste:

```
assercoes sobre ownerDeletion: 13
DIVERGENCIAS: 1
  [toContain] err_state IS DISTINCT FROM '23503'
```

Todas as outras 12 — incluindo `err_constraint IS DISTINCT FROM 'tombstones_owner_id_fkey'`,
`GET STACKED DIAGNOSTICS`, `bypassed the tombstone limitation`, `tombstones_before`,
`Cleanup should have added`, `BEFORE DELETE trigger did not clear source_message_id` e as 9
mensagens de `ROLLBACK did not restore …` — **continuam satisfeitas**. O verificador permanece
internamente coerente; só o teste ficou para trás.

---

## 5. O que a correção exigiria

**Se for autorizado alterar o teste** (é onde está a divergência), a mudança mínima é substituir a
asserção única por uma que reflita o contrato real — a exclusão falha por mecanismo de tombstone,
com SQLSTATE específico:

```ts
// O SQLSTATE depende do caminho: a policy FORCE RLS de `tombstones` barra o INSERT do trigger
// antes da FK `tombstones_owner_id_fkey`. Medido: 42501 em todos os runners. O verificador exige
// um de dois valores e valida a origem de cada um.
expect(ownerDeletion).toContain("IF err_state NOT IN ('23503', '42501') THEN");
expect(ownerDeletion).toContain("tombstones_owner_id_fkey");
expect(ownerDeletion).toContain("RLS rejection did not come from the tombstones table");
```

**Não alterei o teste**, porque a instrução é explícita: *"Não altere o teste apenas para fazê-lo
passar sem demonstrar que o comportamento esperado é obsoleto."* A demonstração está nas Evidências
1-4 acima — mas a decisão de alterar precisa ser autorizada, e ela toca um arquivo de teste
funcional fora do escopo declarado da Etapa 2.

**Não alterei a migration** (proibido nesta etapa).

---

## 6. Achado adicional — documentação também desatualizada

`docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md:604` afirma:

> Excluir definitivamente o owner, com dados presentes | ❌ impossível hoje — falha com
> `SQLSTATE 23503` em `tombstones_owner_id_fkey`

Pela medição, o SQLSTATE real é **42501**, não 23503. A documentação repete o mesmo erro do teste.
**Não alterei** — é artefato de outra rodada e não faz parte do escopo do R41.

---

## 7. Conclusão

| pergunta | resposta |
|---|---|
| A (teste desatualizado) ou B (migration perdeu proteção)? | **A** |
| A proteção existe? | **sim** — e é mais específica que antes |
| O 23503 é alcançável? | **não**, medido em 3 runners |
| Quantas asserções divergem? | **1 de 13** |
| Precisa alterar a migration? | **não** |
| Precisa alterar o teste? | **sim**, se autorizado |
| Alterei algo? | **não** — aguardando autorização |
