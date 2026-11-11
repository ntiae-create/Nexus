# R41 — Integridade de execução e reconciliação dos testes

**Branch:** `arena/53ca4a3e-nexus` · **HEAD:** `1f84f1cc2a1dd9dacd7619b6183fcc4bec997f13` (inalterado)
**Nenhum commit, push, merge, rebase ou publicação.** **A Fase 5.1 NÃO está aprovada.**

---

## 1. Estado do Git

| momento | HEAD | branch | `git diff --check` | `git status --short` |
|---|---|---|---|---|
| inicial | `1f84f1cc…` | `arena/53ca4a3e-nexus` | limpo | 5 `M` + 24 `??` |
| final | `1f84f1cc…` | `arena/53ca4a3e-nexus` | limpo | 5 `M` + 25 `??` (+`docs/r41/`) |

Reflog sem entradas além de `clone` e `checkout`. Nada foi commitado.

**Aviso de ambiente:** o `/tmp` foi zerado novamente entre R40 e R41. Reconstruí PG 17.11 (tarball
npm), `psql` 16.2 (wheel `pgserver` do PyPI), dois clusters descartáveis (55432 regressão, 55433
provas destrutivas) e `node_modules`. Todas as provas foram reexecutadas.

---

## 2. Defeito 1 — o fluxo executava uma cópia arbitrária de `/tmp`

### Reprodução (evidência em `prova/ANTES_copia_tmp.txt`)

Versão **antiga e insegura** colocada em `/tmp/pg_cleanup.sh` (a do R38, com `DROP OWNED` cego):

```
/tmp/pg_cleanup.sh                      md5 6a9abfacee4dd3aa723159dee76ac7c8   <- A INSEGURA
docs/r38/scripts/pg_cleanup.sh          md5 d1429d2772b42fd256d8e156671170c6   <- a corrigida
```

Execução do `install_clean.sh` **antes** da correção:

```
EXIT=0 ; 29 OK ; 0 FALHA

marcadores no log do cleanup:
  'identificar bancos com dependencias' (versão ANTIGA): 1
  'pre-voo'                            (versão NOVA) : 0
```

**O fluxo executou a versão insegura e reportou sucesso.** Além disso, `DBDIR` estava fixo em
`/home/user/Nexus/packages/database` — caminho absoluto literal, quebra em qualquer outro checkout.

### Correção

Três mudanças em `docs/r38/scripts/install_clean.sh`:

1. **`SCRIPT_DIR` resolvido por `BASH_SOURCE` + laço de `readlink`.** `BASH_SOURCE` sozinho **não**
   resolve symlinks — testei: invocado por `/tmp/install_link.sh`, `dirname` devolveria `/tmp` e
   tudo quebraria. O laço corrige isso.
2. **`DBDIR` derivado** (`$SCRIPT_DIR/../../..` + `/packages/database`), com verificação de
   existência.
3. **Cleanup versionado com SHA256 conferido antes de executar.** O artefato auditado no R40 tem
   `sha256 1ccc43fb4397632c4210b3f4588da3df4a1e6e573b87c2bc5b23ceaef67803a2`. Divergência →
   **aborta antes de qualquer operação destrutiva**. Não há cópia intermediária em `/tmp`.

### Sabotagens (evidência em `prova/DEPOIS_caminho_versionado.txt`)

| # | sabotagem | resultado | exit |
|---|---|---|---|
| A | versão **antiga e insegura** em `/tmp/pg_cleanup.sh` | executou o **versionado**; `cleanup em uso: …/pg_cleanup.sh (sha256 1ccc43fb…)`; `pre-voo`=2, mensagem antiga=0; 29 OK / 0 FALHA | **0** |
| B | linha injetada no `pg_cleanup.sh` **versionado** | `ABORTADO: SHA256 do cleanup nao confere` (esperado vs. obtido impressos) | **1** |
| C | arquivo versionado **ausente** | `ABORTADO: cleanup versionado ausente: …` | **1** |
| D | bit de execução removido | `ABORTADO: cleanup versionado nao e executavel: …` | **1** |

**Hash do cleanup realmente executado:**
`1ccc43fb4397632c4210b3f4588da3df4a1e6e573b87c2bc5b23ceaef67803a2`

Um efeito colateral **desejável** apareceu durante os testes: ao criar o banco `r41_verify` no
cluster 55432 com objetos dos papéis, o pré-voo do cleanup R40 **recusou-se a prosseguir**
(`ESCOPO AMBIGUO … Nada foi destruido`). É a proteção operando corretamente contra um artefato que
eu mesmo havia criado.

---

## 3. Defeito 2 — `migrations.test.ts`

Diagnóstico completo em **`docs/r41/DIAGNOSTICO_migrations_test.md`**.

### Correção de um erro do R40

O R40 §10 afirmou que a string faltante estava em `00007_tool_grants_and_preferences.sql`.
**Estava errado.** A asserção lê `tests/postgres/verify-stage-5-owner-deletion.sql`, que **tem**
`err_state` (7×) e `23503` (3×). A falha é a exigência de uma **string exata** que não existe.

### A ou B? → **A: o teste está desatualizado**

**A proteção existe e é mais específica.** O diff `docs/r38/diffs/verify-stage-5-owner-deletion.diff`
registra a mudança deliberada:

```diff
-  IF err_state IS DISTINCT FROM '23503' THEN
+  IF err_state NOT IN ('23503', '42501') THEN
...
+  IF err_state = '42501' AND err_message NOT LIKE '%tombstones%' THEN
+    RAISE EXCEPTION 'RLS rejection did not come from the tombstones table: %', err_message;
```

Não é afrouxamento para "qualquer erro": são **dois SQLSTATEs específicos**, cada um com validação
de origem (constraint `tombstones_owner_id_fkey` para 23503; mensagem contendo `tombstones` para 42501).

### Medição do SQLSTATE real (cluster descartável, banco completamente instalado)

| runner | SQLSTATE | mensagem |
|---|---|---|
| `postgres` (superuser) | **42501** | `new row violates row-level security policy for table "tombstones"` |
| `nexus_migrator` | **42501** | idem |
| `nexus_app` | **42501** | `permission denied for table owner_identity` |

**O 23503 não ocorre em nenhum caso.**

### Por que — mecanismo isolado em teste controlado

```
tombstones:                    relrowsecurity=t, relforcerowsecurity=t   FORCE RLS
trigger record_deleted_entity: prosecdef=t, dono=nexus_migrator          SECURITY DEFINER
postgres:      rolsuper=t, rolbypassrls=t
nexus_migrator: rolsuper=f, rolbypassrls=f
```

| caminho | resultado |
|---|---|
| `INSERT` **direto** como `postgres` (superuser+bypassrls) | **passa** — superuser ignora RLS |
| `INSERT` dentro de função `SECURITY DEFINER` de dono **sem** bypassrls | **`permission denied`** |

O `INSERT` em `tombstones` acontece **dentro do trigger**, que é `SECURITY DEFINER` e executa como
**`nexus_migrator`** — papel comum. A policy FORCE RLS o barra **antes** da FK ser avaliada. O 23503
é **inalcançável por construção**.

**Dois erros factuais no comentário do próprio verificador:** ele diz que o runner superuser chega ao
23503 (medido: recebe 42501) e que o dono do trigger é `postgres` (real: `nexus_migrator`).
A justificativa correta é **mais forte** que a registrada: só 42501 é possível.

### Uma única divergência

Varredura automática das **13 asserções** sobre `ownerDeletion`:

```
assercoes verificadas: 13
DIVERGENCIAS: 1
  [toContain] err_state IS DISTINCT FROM '23503'
```

As outras 12 continuam satisfeitas. O verificador é internamente coerente; só o teste ficou para trás.

### O que **não** fiz e por quê

**Não alterei o teste.** A instrução é explícita: *"Não altere o teste apenas para fazê-lo passar
sem demonstrar que o comportamento esperado é obsoleto."* A demonstração está feita, mas alterar um
teste funcional exige autorização. A mudança mínima proposta está no diagnóstico §5.

**Não alterei a migration** (proibido na etapa).

**Achado adicional:** `docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md:604` também afirma
`SQLSTATE 23503` — mesmo erro, mesma medição o desmente. Não alterei (artefato de outra rodada).

---

## 4. Etapa 3 — revisão da correção R40

Evidência integral em `prova/PG_SHDEPEND_E_DROP_OWNED.txt`.

### Visibilidade do catálogo ≠ escopo de remoção

`pg_shdepend` é **compartilhado**: a mesma linha aparece de qualquer banco.

| banco | sem filtro `dbid` | com filtro `dbid` |
|---|---|---|
| `postgres` | 4 | **0** |
| `nexus_test` | 4 | **1** |
| `sentinela_prod` | 4 | **1** |

Sem filtro, **todo** banco reporta as dependências de todos os outros — era o defeito 2 do R40.
Com `dbid`, cada banco vê só o que lhe pertence.

### Efeito real de `DROP OWNED` (medido, não inferido)

`DROP OWNED BY alvo CASCADE` executado **em `nexus_test`** (banco autorizado):

| objeto | antes | depois | veredito |
|---|---|---|---|
| `nexus_test.s_auto` | 1 | **0** | removido — estava no banco da conexão |
| `sentinela_prod.s_prod` | 1 | **1** | INTACTO |
| `sentinela_dev.s_dev` | 1 | **1** | INTACTO |
| `sentinela_prod.s_prod.dado` | 3 linhas | **3 linhas** | dados intactos |
| `sentinela_dev.s_dev.t_dev` | 2 linhas | **2 linhas** | dados intactos |
| `banco_do_alvo` (`dbid=0`) | 1 | **1** | INTACTO — compartilhado |

**`DROP OWNED` só remove objetos do banco da conexão. Não cruza bancos.**

### Pré-voo termina antes do primeiro DROP

Execução com `alvo` tendo objetos em `sentinela_prod`, `sentinela_dev` **e** sendo dono de um banco:

```
[cluster] 1 dependencia(s) compartilhada(s) — nenhum DROP OWNED as remove
[teste]   nexus_test: 1 dependencia(s) — dentro do escopo
[FORA]    sentinela_dev: 1 dependencia(s) — BANCO NAO AUTORIZADO
[FORA]    sentinela_prod: 1 dependencia(s) — BANCO NAO AUTORIZADO
[FORA]    banco_do_alvo: o BANCO pertence ao papel — NAO AUTORIZADO
ESCOPO AMBIGUO … Nada foi destruido. Nenhum DROP DATABASE, DROP OWNED ou DROP ROLE foi executado.
EXIT=1
```

Depois da recusa: `nexus_test.s_auto2=1`, `sentinela_prod.s_prod=1` (3 linhas),
`sentinela_dev.s_dev=1` (2 linhas), `banco_do_alvo=1` — **tudo preservado, inclusive os bancos
autorizados**, porque o aborto ocorre antes da fase destrutiva.

---

## 5. Regressão

| item | resultado |
|---|---|
| instalação integral | **exit 0 · 29 OK · 0 FALHA** |
| isolamento do runtime | **28/28** |
| sabotagem dos verificadores | **5/5 detectados**, 0 não detectados |
| testes de integração (`nexus_app`) | **21/21** |
| `npm test` | **1 falha preexistente** (§6) |
| `git diff --check` | **limpo** |
| `package-lock.json` | **inalterado** |
| migrations 00001–00007 | **intactas** (MD5 em `logs/migrations.md5`, idênticos ao R40) |
| runtime/API/repositórios | **não alterados** |

### §6 — Classificação das falhas

| categoria | item | estado |
|---|---|---|
| **preexistente** | `migrations.test.ts` — asserção `err_state IS DISTINCT FROM '23503'` | 1 falha; diagnóstico §3; correção requer autorização |
| **nova** | nenhuma | — |
| **não executada** | `test_provisioning.sh`, `test_integrity.sh`, `test_preexisting_role.sh` (docs/r35) | **não executados** — são scripts do R35 que ainda invocam `/tmp/pg_cleanup.sh` por caminho fixo e não fazem parte do fluxo do `install_clean.sh`; executá-los exigiria instalar cópias em `/tmp`, exatamente o antipadrão que esta rodada corrige |

**`npm test` completo:** `1 failed | 790 passed | 28 skipped (819)` — idêntico ao R40, o que confirma
que a correção do R41 não introduziu nem removeu falhas.

---

## 7. Diff completo

`docs/r41/diffs/install_clean.diff` — 82 linhas, 3 hunks.

Gerado contra `/tmp/ic_r40.sh`, reconstruído por extração do patch R38
(`docs/r38/ENTREGA_FASE_5.1.diff`) seguida da aplicação do diff do R39
(`docs/r39/diffs/install_clean.diff`). O MD5 do resultado, **`809412d29e7cafbdb299e0f97afeacc4`**,
confere exatamente com o registrado no relatório R40 — o que valida a reconstrução e garante que o
diff R41 contém **apenas** as mudanças desta rodada.

---

## 8. Hashes MD5 (arquivos finais)

```
6752999521fdb1265b2b66be1164e39b  docs/r38/scripts/install_clean.sh    (ALTERADO no R41)
d1429d2772b42fd256d8e156671170c6  docs/r38/scripts/pg_cleanup.sh        (INTOCADO no R41)
6a9abfacee4dd3aa723159dee76ac7c8  docs/r35/pg_cleanup.sh                (INTOCADO — âncora)
```

Valores efetivos em `docs/r41/MANIFEST_r41.md5`, gerado **após** todas as edições e validado com
`md5sum -c`.

---

## 9. Limitações restantes

1. **`migrations.test.ts` continua falhando** (1 de 819). Diagnóstico completo; correção aguarda
   autorização porque altera um teste funcional.
2. **`docs/FASE_5_G13_…md:604`** afirma `SQLSTATE 23503`; a medição diz 42501. Pendente.
3. **O comentário do verificador** (`verify-stage-5-owner-deletion.sql`) tem duas imprecisões
   factuais sobre o mecanismo, embora o código esteja correto e mais estrito.
4. **Os três scripts de `docs/r35`** ainda invocam `/tmp/pg_cleanup.sh` por caminho fixo — o mesmo
   defeito corrigido no `install_clean.sh` permanece neles. Não foram alterados (fora do escopo).
5. **O `pg_cleanup.sh` continua com 16 conexões como `postgres`** (R40 §9). A redução exige mudar o
   provisionamento.
6. **`/tmp` ainda é usado** para `LD_LIBRARY_PATH`, `PSQL`, `install_ctx.sql` e logs. São caminhos de
   *ferramenta*, não de artefato auditado; mas o ambiente continua efêmero e precisa ser
   reconstruído a cada sessão (aconteceu nas três últimas rodadas).

---

## 10. Conclusão

| critério | estado |
|---|---|
| o fluxo executa exatamente o cleanup versionado e auditado | **demonstrado** (§2, sabotagens A-D) |
| caminho resolvido pela localização real do script | **sim** (`BASH_SOURCE` + `readlink`, testado com symlink) |
| falha de resolução/cópia/verificação interrompe a instalação | **sim** — 3 sabotagens, todas exit 1 |
| nenhuma operação destrutiva antes da validação | **sim** — SHA256 conferido antes da fase 1 |
| `pg_shdepend` compartilhado ≠ escopo de remoção | **demonstrado empiricamente** (§4) |
| falha de `migrations.test.ts` diagnosticada | **sim, com correção do erro do R40** |
| migrations e runtime intactos | **sim** |

**Não declaro a Fase 5.1 aprovada.** Restam as pendências 1-3 do §9, todas dependentes de
autorização para alterar arquivos fora do escopo desta rodada.
