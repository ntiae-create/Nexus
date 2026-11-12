# Consolidação R38–R42 — relatório de versionamento

Branch: `arena/53ca4a3e-nexus` · base `1f84f1cc` · **sem push, sem merge, sem PR**

## Commits

| # | hash | mensagem |
|---|---|---|
| 1 | `92f7758` | `fix(database): escopo destrutivo seguro no cleanup de papeis PostgreSQL` |
| 2 | `9bc8636` | `fix(database): instalador executa o cleanup versionado, com SHA256 conferido` |
| 3 | `2cda775` | `feat(database): Fase 5.1 — grants de ferramentas e preferencias por owner` |
| 4 | `c6435b9` | `test(tools): catalogo de ferramentas como fonte unica de verdade` |
| 5 | `c2275fc` | `test(database): alinha assercao de SQLSTATE ao comportamento do verificador` |
| 6 | `766f011` | `docs(fase-5.1): especificacao tecnica do catalogo global x configuracoes pessoais` |
| 7 | `18834da` | `docs(auditoria): registros de auditoria e provas das rodadas R35-R42` |

## Arquivos por commit

1. **`92f7758`** — 9 arquivos, +1327. `docs/r35/{pg_cleanup.sh,run_pg17.sh,test_integrity.sh,test_preexisting_role.sh,test_provisioning.sh}`; `docs/r38/scripts/{pg_cleanup.sh,exp_selfgrant.sh,sabotagem_r38.sh,test_runtime_isolation.sh}`
2. **`9bc8636`** — `docs/r38/scripts/install_clean.sh`, +398
3. **`2cda775`** — 8 arquivos, +3351/−11. `migrations/00007_tool_grants_and_preferences.sql`; 5 `verify-stage-5-*.sql`; `bootstrap.sql`; `test-postgres-integration.sh`
4. **`c6435b9`** — `packages/assistant-profiles/src/catalog.ts`, `packages/tools/src/tools.test.ts`, +24/−4
5. **`c2275fc`** — `packages/database/src/migrations.test.ts`, +211
6. **`766f011`** — `docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md`, +1555
7. **`18834da`** — 37 arquivos, +22412. `docs/r35` (3), `docs/r38` (6), `docs/r39` (4), `docs/r40` (10), `docs/r41` (8), `docs/r42` (5), + `docs/r42/NOTA_VERSIONAMENTO.md`

## Verificação

- `git diff --check` limpo antes e depois
- `npm test` → **EXIT=0**, 61 passed | 5 skipped (66) arquivos; **791 passed** | 28 skipped (819) testes
- `git diff HEAD --stat` vazio após os commits → o que está em disco é exatamente o que foi commitado
- Hashes do HEAD batem com os manifestos: `pg_cleanup.sh` `d1429d27…`, `install_clean.sh` `67529995…`, `migrations.test.ts` `8de42ef6…`, `00007_tool_grants…sql` `538fc52d…`

## Defeito do owner — PENDENTE, não resolvido

```
DELETE FROM nexus.owner_identity WHERE id='00000000-0000-4000-8000-000000000004'
→ ERROR: new row violates row-level security policy for table "tombstones"
   (trigger record_deleted_entity, linha 6)
→ EXIT=1; owner_identity continua com 1 linha
```

SQLSTATE real **42501**, não 23503. Causa: o INSERT em `tombstones` acontece dentro do
trigger `SECURITY DEFINER`, que roda como `nexus_migrator` (`rolsuper=f`, `rolbypassrls=f`);
o FORCE RLS de `tombstones` barra antes de a FK ser avaliada. O 23503 é inalcançável.

A Fase 5.1 **não** resolve isso. Evidência: `docs/r42/prova/DEFEITO_OWNER_PENDENTE.txt`.

## Pendências

1. **Defeito do owner não corrigido** — decisão de produto: apagar dados do owner em cascata
   antes do DELETE, ou política explícita de "owner não é excluível".
2. **`docs/FASE_5_G13_…md:604`** afirma `SQLSTATE 23503`; o real é 42501. Os 3 itens do
   diagnóstico documental aguardam autorização (não alterei).
3. **Manifestos com entradas ausentes** — r38 26/29, r40 9/14 (5 logs perdidos por
   ambiente). Documentado em `docs/r40/NOTA_INTEGRIDADE.md`; não reescrevi hashes.
4. **Logs não versionados** (`*.log` no `.gitignore`) — ver `docs/r42/NOTA_VERSIONAMENTO.md`.
5. **Sem push** — os 7 commits existem apenas localmente, conforme instruído.
