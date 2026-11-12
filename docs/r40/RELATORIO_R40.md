# R40 — Correção do escopo destrutivo do `pg_cleanup.sh`

**Branch:** `arena/53ca4a3e-nexus` · **HEAD:** `1f84f1cc2a1dd9dacd7619b6183fcc4bec997f13` (inalterado)
**Nenhum commit, push, merge, rebase ou publicação foi executado.**
**A Fase 5.1 NÃO está aprovada.** Este relatório entrega evidências para revisão independente.

---

## 1. Estado do Git

| momento | HEAD | branch | `git diff --check` | `git status --short` |
|---|---|---|---|---|
| inicial | `1f84f1cc…` | `arena/53ca4a3e-nexus` | limpo | 5 `M` + 24 `??` |
| final | `1f84f1cc…` | `arena/53ca4a3e-nexus` | limpo | 5 `M` + 28 `??` |

O reflog não contém nenhuma entrada além do `checkout` inicial e do `clone`. Nada foi commitado.

---

## 2. Defeito original

```bash
# ORIGINAL, linhas 42-47
for db in $($PSQL ... "SELECT datname FROM pg_database WHERE NOT datistemplate ..."); do
  n=$($PSQL -d "$db" -tAc "SELECT count(*) FROM pg_shdepend WHERE refobjid='$oid'::oid;" 2>/dev/null)
  [ "${n:-0}" != "0" ] && { echo " [$db] $n dependencia(s)"; local_found="$local_found $db"; }
  $PSQL -X $HOST -d "$db" -q -c "DROP OWNED BY $r CASCADE;" >/dev/null 2>&1
done
```

Três defeitos na mesma construção:

1. **Escopo.** O laço itera **todos** os bancos não-template. `TEST_DATABASES` protegia apenas o
   `DROP DATABASE` (linha 57-61), nunca o `DROP OWNED` da linha 46. Objetos do papel em qualquer
   outro banco eram destruídos.
2. **Silêncio.** `>/dev/null 2>&1` descartava sucesso, falha e mensagem. O script sempre retornava
   0; o único sinal era a string `AINDA PENDENTE`.
3. **`pg_shdepend` sem filtro de `dbid`.** Descoberto ao corrigir: `pg_shdepend` é catálogo
   **compartilhado**; a mesma linha é visível de qualquer banco. Sem `dbid`, cada banco reportava as
   dependências de todos os outros, e `local_found` — a lista que decide **qual banco derrubar** —
   vinha envenenada.

### Reprodução (cluster descartável 55433, evidência integral em `prova/ANTES_defeito.txt`)

```
--- estado do sentinela ANTES ---
  s_prod.dado: 3 linha(s)

--- execucao do script ORIGINAL ---
== 1. bancos de teste (derrubar primeiro: leva pg_shdepend junto) ==
   nexus_test: DROP DATABASE
== 2. papel por papel ...
   --- alvo_teste (oid 16405) ---
     [postgres] 1 dependencia(s)
     [sentinela_prod] 1 dependencia(s)
     DROP ROLE: DROP ROLE
== 3. estado final ==
   bancos: postgres, sentinela_prod
exit=0

--- estado do sentinela DEPOIS ---
  schema s_prod existe: 0
  tabela s_prod.dado existe: 0
```

O script **reportou sucesso** enquanto destruía um banco fora da lista.

---

## 3. Correção

A correção não é só um filtro: é uma **reordenação em fases**, para que escopo ambíguo nunca chegue
a destruir nada.

| fase | ação | destrutiva? |
|---|---|---|
| **A** | valida identificadores (regex `^[A-Za-z_][A-Za-z0-9_]*$`, ≤63 bytes) | não |
| **B** | **pré-voo:** mapeia dependências por (papel, banco) com `dbid` correto; mapeia bancos de propriedade do papel. Se algo estiver fora de `TEST_DATABASES` → **`exit 1` sem destruir nada** | não |
| **C.1** | `DROP OWNED` — laço **somente** sobre `TEST_DATABASES`; consulta antes se o banco existe | **sim** |
| **C.2** | `DROP DATABASE IF EXISTS … WITH (FORCE)` — laço **somente** sobre `TEST_DATABASES` | **sim** |
| **D** | `DROP ROLE` — apenas papéis aprovados no pré-voo | **sim** |
| **E** | relatório; `exit` reflete `FAILS` e conta papéis realmente removidos | não |

### Decisões de desenho

**Por que o pré-voo aborta em vez de "ignorar os bancos fora do escopo":** ignorar deixaria o papel
vivo, o `DROP ROLE` falharia depois de já ter derrubado os bancos de teste, e o resultado seria um
ambiente meio destruído. Abortar no pré-voo preserva **tudo** — inclusive os bancos autorizados.
Medido: no Cenário A os 6 bancos continuam existindo após a recusa.

**Por que o `DROP OWNED` roda antes do `DROP DATABASE` (C.1 antes de C.2):** na ordem anterior o
`DROP OWNED` era **inalcançável** — C derrubava todos os bancos de teste e, se algum falhasse, o
script abortava antes de D. Código destrutivo que nunca executa não pode ser provado seguro; ao
movê-lo para antes, ele é exercitado (evidência: `so_teste @ nexus_test: DROP OWNED ok`).

**O que foi deliberadamente NÃO feito:** não se concedeu privilégio nem se revogou nada (`GRANT`=0,
`REVOKE`=0), não se enfraqueceu RLS, não se alterou `install_clean.sh` nem migrations. O patch toca
**um único arquivo**.

---

## 4. Diff completo

Arquivo: `docs/r40/diffs/pg_cleanup.diff` (315 linhas, 1 hunk — reescrita substancial).
Gerado contra `/tmp/pg_cleanup_original_r40.sh`, cópia tirada **antes** de qualquer edição, com
MD5 `6a9abfacee4dd3aa723159dee76ac7c8` — idêntico a `docs/r35/pg_cleanup.sh`, que **permaneceu
intocado** e serve de âncora independente.

---

## 5. Inventário de operações destrutivas

Ver `docs/r40/INVENTARIO_OPERACOES_DESTRUTIVAS.md`. Resumo:

| operação | ocorrências | banco de conexão | papel | proteção |
|---|---|---|---|---|
| `DROP OWNED BY "r" CASCADE` | **1** (linha 197) | cada `$db` de `TEST_DATABASES` | `postgres` | laço itera só a lista; `is_test_db` confirma; consulta prévia de existência |
| `DROP DATABASE IF EXISTS "db" WITH (FORCE)` | **1** (linha 214) | `postgres` | `postgres` | laço itera só a lista; nome validado |
| `DROP ROLE "r"` | **1** (linha 231) | `postgres` | `postgres` | papel só passa se o pré-voo não achou dependência fora do escopo |

**Ausentes por completo:** `DROP SCHEMA`=0, `REASSIGN OWNED`=0, `GRANT`=0, `REVOKE`=0, `ALTER`=0,
`TRUNCATE`=0, `|| true`=0, `2>/dev/null`=0.

---

## 6. Evidência antes/depois dos bancos-sentinela

Cluster descartável `127.0.0.1:55433`, criado exclusivamente para esta prova. Evidência integral em
`docs/r40/prova/ISOLAMENTO.txt`.

Cenário: `alvo_teste` é dono de schema em `nexus_test` (autorizado) **e** em `sentinela_prod` (fora);
`alvo_dev` em `sentinela_dev` (fora).

### Cenário A — dependência fora do escopo ⇒ recusa

| item | antes | depois | veredito |
|---|---|---|---|
| `nexus_test`, `nexus_prov_test` | existem | **existem** | não tocados |
| `sentinela_prod` | existe | **existe** | preservado |
| `sentinela_dev` | existe | **existe** | preservado |
| `sentinela_vazio` | existe | **existe** | preservado |
| `s_prod` (schema, dono `alvo_teste`) | existe | **existe** | preservado |
| `s_prod.dado` (5 linhas) | 5 | **5** | dados intactos |
| `s_dev.t_dev` (2 linhas) | 2 | **2** | dados intactos |
| `s_neutro.n` (1 linha) | 1 | **1** | dados intactos |
| owners | `alvo_teste`/`alvo_dev`/`postgres` | **idênticos** | inalterados |
| ACL de `s_prod` | `alvo_teste=UC/alvo_teste, =U/alvo_teste` | **idêntica** | inalterada |
| **exit** | — | **1** | falha propagada |

Mensagem: `== ESCOPO AMBIGUO … Nada foi destruido. Nenhum DROP DATABASE, DROP OWNED ou DROP ROLE foi executado.`

### Cenário B — dependências só em banco autorizado ⇒ limpa

| item | resultado |
|---|---|
| `so_teste @ nexus_test` | `DROP OWNED ok` |
| `nexus_test`, `nexus_prov_test` | removidos |
| `sentinela_prod` / `.dado` | **existe / 5 linhas** |
| `sentinela_dev` / `.t_dev` | **existe / 2 linhas** |
| `sentinela_vazio` / `.n` | **existe / 1 linha** |
| owners e ACLs | inalterados |
| **exit** | **0** |

---

## 7. Sabotagens

Evidência: `docs/r40/prova/SABOTAGEM_ESCOPO.txt`.

| # | vetor | resultado | exit | alvo |
|---|---|---|---|---|
| 1 | injeção SQL no argumento: `x; DROP DATABASE alvo_sabotado; --` | `FALHA identificador invalido: 'x;'` → `ABORTADO` | **1** | **preservado (3 linhas)** |
| 2 | metacaractere: `nexus"; DROP DATABASE alvo_sabotado; --` | `FALHA identificador invalido: 'nexus";'` → `ABORTADO` | **1** | **preservado (3 linhas)** |
| 3 | banco com nome de **prefixo**: `nexus_test_prod` (prefixo de `nexus_test`) | não foi tocado; só `nexus_test` foi limpo | 0 | **preservado (3 linhas)** |

A sabotagem 3 verifica que o casamento de nomes é **exato** (`case " $LISTA " in *" $nome "*) e não
por prefixo — um `nexus_test_prod` jamais é confundido com `nexus_test`.

---

## 8. Exit codes — todos os cenários de falha

Evidência: `docs/r40/prova/FALHAS_PROPAGACAO.txt`.

| cenário | exit | esperado | ok? |
|---|---|---|---|
| F1 falha de conexão (porta inexistente) | **1** | ≠0 | ✅ |
| F2 papel inexistente | 0 | 0 (nada a fazer) | ✅ |
| F3 banco autorizado inexistente | 0 | 0 (`IF EXISTS`) | ✅ |
| F4 `DROP DATABASE` sem privilégio | **1** | ≠0 | ✅ |
| F5 `DROP ROLE` sem ADMIN option | **1** | ≠0 | ✅ |
| F6 dependência fora do escopo | **1** | 1 | ✅ |
| F7 argumento vazio | **1** | ≠0 | ✅ |
| F8 relatório final com status verificado | — | — | ✅ (código auditado) |

F4 e F5 falharam **pelo motivo certo**, não por acidente: `ERROR: must be owner of database
nexus_test` e `ERROR: permission denied to drop role … Only roles with the CREATEROLE attribute and
the ADMIN option`. Nenhuma falha obrigatória termina em 0.

---

## 9. Contagem de conexões superuser (medida, não estimada)

Evidência: `docs/r40/logs/contagem_conexoes.txt`. Método: wrapper `psql` que registra cada invocação.

| componente | conexões | como `postgres` |
|---|---|---|
| `install_clean.sh` integral (inclui cleanup) | **93** | **57** |
| `pg_cleanup.sh` corrigido, isolado | **16** | **16** |

**As contagens anteriores estavam erradas.** O R38 disse "1 de 20"; o R39 corrigiu para "2 de 30" —
mas ambas eram **contagem estática de linhas**, e `run_as`/`run_with_ctx` são chamados em laço. A
medição empírica dá 93 conexões totais e 57 como `postgres`.

O cleanup passou de 10 para 16 conexões **porque a correção adiciona três verificações** que antes
não existiam (existência do banco antes de conectar, bancos de propriedade do papel, papéis
remanescentes). Mais conexões aqui são o preço de não esconder falhas.

### Redução é possível? Investigado, não aplicado

Teste com papel `CREATEDB CREATEROLE` **sem** superuser:

| operação | sem superuser |
|---|---|
| `CREATE DATABASE` / `DROP DATABASE` do próprio banco | **funciona** |
| `CREATE ROLE` | **funciona** |
| `DROP ROLE` com `ADMIN OPTION` no alvo | **funciona** |
| `DROP OWNED` em banco de terceiro | **BLOQUEADO** (`Only roles with privileges of role "X"…`) |

Conclusão: as operações destrutivas **não exigem superuser por natureza**. Daria para zerar as 16
conexões superuser **se** o executor recebesse `ADMIN OPTION` sobre os papéis-alvo **e** fosse dono
dos bancos de teste. Isso muda o **provisionamento** (quem cria papéis e bancos) — está fora do
escopo autorizado. **Não foi implementado.** A prioridade declarada era a segurança do escopo, não a
redução artificial do número.

---

## 10. Regressão

| item | resultado |
|---|---|
| `install_clean.sh` integral (cluster descartável) | **exit 0 · 29 OK · 0 FALHA** |
| D-6 (prova negativa `INHERIT`) no fluxo | **OK**, SQLSTATE `42501` |
| isolamento do runtime | **28/28** |
| sabotagem dos verificadores | **5/5 detectados**, 0 não detectados |
| testes de integração (`nexus_app`) | **21/21** |
| `npm test` | **1 falha preexistente** (ver abaixo) |
| `package-lock.json` | **inalterado** (`git diff` vazio) |
| `git diff --check` | **limpo** |
| migrations 00001–00007 | **intactas** (MD5 por arquivo em `MANIFEST_r40.md5`) |
| runtime / API / repositórios | **não alterados** |

### A falha do `npm test` — preexistente, alheia a este patch

```
Test Files  1 failed | 60 passed | 5 skipped (66)
     Tests  1 failed | 790 passed | 28 skipped (819)

FAIL packages/database/src/migrations.test.ts
  > keeps Phase 5 grants isolated by owner_id and audited append-only
  AssertionError: expected '\set ON_ERROR_STOP on\n-- Fase 5 (G13…' to contain
                  'err_state IS DISTINCT FROM ''23503'''
```

O teste lê `packages/database/migrations/00007_tool_grants_and_preferences.sql` e exige a string
`err_state IS DISTINCT FROM '23503'`, que **não existe** nesse arquivo (`grep -c` = 0 para `err_state`
e para `23503`). Ambos os arquivos vêm do R38/R39 (`M` e `??`); **nenhum foi tocado nesta rodada** e
nenhum é invocado pelo `pg_cleanup.sh`. A causa é a divergência entre o verificador e a migration,
fora do escopo do R40.

**Não corrigi** — alterar a 00007 violaria a regra de não tocar migrations. Fica registrado como
pendência aberta.

---

## 11. Hashes MD5 (arquivos finais, após todas as alterações)

```
d1429d2772b42fd256d8e156671170c6  docs/r38/scripts/pg_cleanup.sh      (CORRIGIDO)
6a9abfacee4dd3aa723159dee76ac7c8  docs/r35/pg_cleanup.sh              (INTOCADO — âncora)
b036f736b6b5406d11675afd87c4bf98  docs/r40/diffs/pg_cleanup.diff
```

O hash vigente está em `docs/r40/MANIFEST_r40.md5`, gerado **depois** de todas as edições.

---

## 12. Limitações e pendências

1. **`npm test` tem 1 falha preexistente** (`migrations.test.ts` × `00007`). Não é regressão deste
   patch, mas impede declarar a suíte totalmente verde.
2. **16 conexões como `postgres`** permanecem no cleanup. A redução é viável (ver §9) mas exige mudar
   o provisionamento — fora do escopo autorizado.
3. **A ordem C.1 antes de C.2 muda a semântica**: agora os objetos são limpos antes de o banco cair.
   Verificado que o resultado final é equivalente (`install_clean.sh` 29 OK/0 FALHA), mas é uma
   mudança de comportamento, não apenas de filtro.
4. **`docs/r35/run_pg17.sh` e `test_integrity.sh` têm trailing whitespace** (preexistente, do R35,
   não tocados).
5. **O fluxo ainda depende de `/tmp/pg_cleanup.sh`**: `install_clean.sh` invoca o caminho em `/tmp`,
   não o versionado. Uma cópia obsoleta em `/tmp` executaria código antigo. Não corrigido aqui
   (exigiria editar `install_clean.sh`, fora do escopo do R40).

---

## 13. Conclusão

| critério de conclusão | estado |
|---|---|
| nenhuma operação destrutiva alcança bancos fora da lista | **demonstrado** (§6, §7) |
| sentinelas preservados integralmente | **demonstrado** (§6) |
| falhas obrigatórias propagam exit ≠ 0 | **demonstrado** (§8) |
| fluxo completo de instalação funcional | **demonstrado** (§10: 29 OK / 0 FALHA) |
| relatório e manifesto correspondem aos arquivos entregues | **sim** (§11) |

**Não declaro a Fase 5.1 aprovada.** As pendências 1, 2 e 5 do §12 seguem abertas e precisam de
decisão.
