# R42 — Reconciliação da asserção de SQLSTATE

**Branch:** `arena/53ca4a3e-nexus` · **HEAD:** `1f84f1cc2a1dd9dacd7619b6183fcc4bec997f13` (inalterado)
**Nenhum commit, push, merge, rebase ou publicação.** **A Fase 5.1 NÃO está aprovada.**

---

## 1. Estado do Git

| momento | HEAD | branch | `git diff --check` | `git status --short` |
|---|---|---|---|---|
| inicial | `1f84f1cc…` | `arena/53ca4a3e-nexus` | limpo | 5 `M` + 24 `??` |
| final | `1f84f1cc…` | `arena/53ca4a3e-nexus` | limpo | 5 `M` + 25 `??` (+`docs/r42/`) |

Reflog sem entradas além de `clone` e `checkout`.

---

## 2. Escopo executado

**Um único arquivo alterado:** `packages/database/src/migrations.test.ts`
**Uma única asserção substituída** (linha 334), substituída por duas asserções equivalentes em
força. Nada mais foi tocado.

| arquivo | antes | depois |
|---|---|---|
| `packages/database/src/migrations.test.ts` | md5 `164ca19a3a76eb93022906adb69ffad5` | md5 `8de42ef6edde0f88cc9045df60d2fb9b` |

### Diff completo (`docs/r42/diffs/migrations.test.diff`)

```diff
@@ -331,7 +331,22 @@
       "utf8",
     );
     // B2: a falha com dados presentes e assercao, nao comentario.
-    expect(ownerDeletion).toContain("err_state IS DISTINCT FROM '23503'");
+    //
+    // R42 — o SQLSTATE esperado e 42501, nao 23503. Medido em cluster descartavel com o banco
+    // completamente instalado, em tres runners (postgres, nexus_migrator, nexus_app): sempre 42501.
+    // O motivo: o INSERT em `tombstones` nao e feito pelo runner, e sim DENTRO do trigger
+    // `record_deleted_entity`, que e SECURITY DEFINER e portanto executa com os privilegios do seu
+    // dono — `nexus_migrator` (rolsuper=f, rolbypassrls=f). A policy de FORCE ROW LEVEL SECURITY da
+    // tabela `tombstones` barra a operacao ANTES de a FK `tombstones_owner_id_fkey` ser avaliada, de
+    // modo que o 23503 e inalcancavel por construcao.
+    //
+    // A assercao NAO foi afrouxada para aceitar "qualquer erro": ela exige o conjunto FECHADO de
+    // exatamente dois SQLSTATEs e, mais abaixo, a validacao da ORIGEM de cada um (constraint
+    // `tombstones_owner_id_fkey` para 23503; mensagem referenciando `tombstones` para 42501).
+    expect(ownerDeletion).toContain("IF err_state NOT IN ('23503', '42501') THEN");
+    expect(ownerDeletion).toContain(
+      "IF err_state = '42501' AND err_message NOT LIKE '%tombstones%'",
+    );
     expect(ownerDeletion).toContain("err_constraint IS DISTINCT FROM 'tombstones_owner_id_fkey'");
     expect(ownerDeletion).toContain("GET STACKED DIAGNOSTICS");
     // B1: a limpeza se declara contorno, e nao cenario real.
```

Um hunk, 17 linhas alteradas. A linha seguinte (`err_constraint IS DISTINCT FROM 'tombstones_owner_id_fkey'`)
**permaneceu intacta** — por isso a asserção continua exigindo a validação de origem.

---

## 3. A falha, antes e depois

| momento | exit | resultado |
|---|---|---|
| **antes** (`logs/ANTES_migrations_test.log`) | **1** | `1 failed \| 13 passed (14)` — `AssertionError: expected … to contain 'err_state IS DISTINCT FROM \'23503\''` |
| **depois** (`logs/DEPOIS_migrations_test.log`) | **0** | `14 passed (14)` |

---

## 4. Prova de que a asserção NÃO foi enfraquecida

A correção não trocou uma exigência estrita por uma permissiva. Sabotei o **verificador** (não o
teste) em dois cenários, e a asserção nova detectou **ambos**:

| # | sabotagem no `verify-stage-5-owner-deletion.sql` | teste | mensagem |
|---|---|---|---|
| 1 | `IF err_state NOT IN ('23503','42501')` → `IF false` (aceitaria **qualquer** SQLSTATE) | **exit 1** | `to contain 'IF err_state NOT IN (\'23503\', \'425…'` |
| 2 | removida a validação de origem do 42501 | **exit 1** | `to contain 'IF err_state = \'42501\' AND err_mess…'` |

O verificador foi restaurado e confere **byte a byte** com o original
(`sha256 13afb7f31b462b7be388855a5788bd1242c97e1b2a058a47d5053f874c3c4ad9`).

### Contagem de asserções

Antes (R41): 13 asserções sobre `ownerDeletion`. Depois: 14 — **aumentou**, porque a asserção
frouxa foi substituída por **duas** mais precisas. Nenhuma verificação foi removida.

---

## 5. Verificações executadas

| item | resultado |
|---|---|
| `migrations.test.ts` isolado | **14 passed** (era 1 failed / 13 passed) |
| **`npm test` integral** | **exit 0** · `61 passed \| 5 skipped (66)` · `791 passed \| 28 skipped (819)` |
| testes de integração (`nexus_app`) | **21/21** |
| isolamento do runtime | **28/28** |
| instalação integral | **29 OK / 0 FALHA**, `cleanup em uso: …/pg_cleanup.sh` |
| sabotagem dos verificadores | **5/5 detectados**, 0 não detectados |
| `git diff --check` | **limpo** |
| migrations 00001–00007 | **idênticas ao R41** (hashes conferidos um a um) |
| runtime / repositórios / políticas RLS | **não alterados** |
| `package-lock.json` | **inalterado** |

**A suíte está totalmente verde pela primeira vez.** O R40 e o R41 registravam
`1 failed | 790 passed`; agora é `791 passed`, exit 0.

---

## 6. Diagnóstico documental (NÃO aplicado)

Documento completo em **`docs/r42/DIAGNOSTICO_DOCUMENTAL.md`**. Resumo:

| # | arquivo | linha | defeito | evidência |
|---|---|---|---|---|
| 1 | `verify-stage-5-owner-deletion.sql` | 315-317 | afirma que runner **superuser** produz 23503 | medido: 42501 também como `postgres`; o `INSERT` roda dentro do trigger, não no runner |
| 2 | `verify-stage-5-owner-deletion.sql` | 318 | diz dono do trigger = **`postgres`** | `pg_proc.proowner` = **`nexus_migrator`** |
| 3 | `docs/FASE_5_G13_…md` | 604 | afirma `SQLSTATE 23503` | medido: **42501** em todos os runners |

**Nenhum foi alterado.** A autorização do R42 é explícita: *"Está autorizado alterar exclusivamente
a asserção divergente"*. Os textos de substituição propostos estão no documento, prontos para
aplicação mediante autorização.

Fatos que fundamentam os três itens:

```
record_deleted_entity | SECURITY DEFINER=true | dono=nexus_migrator
postgres             | super=true  | bypassrls=true
nexus_migrator       | super=false | bypassrls=false
tombstones           | rls=true    | force=true
```

**Observação relevante:** o **código** do verificador está correto e é mais estrito que a
justificativa escrita ao lado dele. As três correções são de **texto**; nenhuma validação seria
removida em nenhuma delas.

---

## 7. Hashes MD5 (arquivos finais)

```
8de42ef6edde0f88cc9045df60d2fb9b  packages/database/src/migrations.test.ts   (ALTERADO no R42)
6752999521fdb1265b2b66be1164e39b  docs/r38/scripts/install_clean.sh          (INTOCADO no R42)
d1429d2772b42fd256d8e156671170c6  docs/r38/scripts/pg_cleanup.sh            (INTOCADO no R42)
6a9abfacee4dd3aa723159dee76ac7c8  docs/r35/pg_cleanup.sh                    (INTOCADO — âncora)
```

Valores efetivos em `docs/r42/MANIFEST_r42.md5`, gerado após todas as edições e validado com
`md5sum -c`.

---

## 8. Limitações restantes

1. **Três documentos descrevem o mecanismo de forma errada** (§6). Sem impacto em execução, mas
   induzem a erro em revisão. Aguardam autorização.
2. **Os scripts de `docs/r35`** (`test_provisioning.sh`, `test_integrity.sh`,
   `test_preexisting_role.sh`) ainda invocam `/tmp/pg_cleanup.sh` por caminho fixo — mesmo defeito
   corrigido no `install_clean.sh` no R41. Não executados nesta rodada por esse motivo.
3. **`pg_cleanup.sh` mantém 16 conexões como `postgres`** (R40 §9). Redução exige mudar o
   provisionamento.
4. **A exclusão definitiva do owner com dados presentes continua impossível** — é um defeito real
   do produto, não do teste. O R42 apenas alinhou a asserção ao comportamento observado; **não
   corrigiu o defeito**.
5. **`/tmp` continua efêmero.** Nesta rodada o ambiente sobreviveu, mas nas três anteriores foi
   zerado e precisou ser reconstruído.

---

## 9. Conclusão

| critério | estado |
|---|---|
| apenas a asserção divergente foi alterada | **sim** — 1 arquivo, 1 hunk, 17 linhas |
| migrations 00001–00007 intactas | **sim** — hashes idênticos ao R41 |
| runtime / repositórios / RLS intactos | **sim** |
| nenhuma verificação de segurança removida | **sim** — asserções passaram de 13 para 14 |
| validação não aceita qualquer SQLSTATE | **provado** por duas sabotagens |
| teste falha antes e passa depois | **sim** — exit 1 → exit 0 |
| `npm test` integral | **exit 0 · 791 passed** |
| artefatos R38–R41 preservados | **sim** |

**Não declaro a Fase 5.1 aprovada.** As pendências do §8 — em especial os três documentos com
informação incorreta e o defeito real de exclusão do owner — seguem abertas.
