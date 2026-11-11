# R39 — Fechamento das pendências da auditoria R38

**Escopo:** D-6 (prova negativa de `INHERIT`), D-5 (auditoria do cleanup) e revisão de propagação
de erros. **Não** se declara a Fase 5.1 aprovada.
**Repo:** `HEAD 1f84f1c`, branch `arena/53ca4a3e-nexus`. Nenhum commit, push ou merge.
**Migrations 00001–00007:** nenhuma alterada. **Runtime:** nenhum código alterado.

> **Aviso de ambiente.** O `/tmp` foi reintegralizado entre R38 e R39: cluster PG, `psql`,
> `pgdata`, todos os scripts auxiliares e `node_modules` desapareceram. Foi necessário reconstruir
> o ambiente (PG 17.11 via npm, cliente `psql` 16.2 via wheel do PyPI) e **restaurar os scripts a
> partir dos artefatos versionados**, com prova de MD5 idêntico. Isso não invalida as provas — todas
> foram reexecutadas — mas explica por que D-5.2 começa com "arquivo ausente".

---

## Sumário dos achados

| # | achado | gravidade | estado |
|---|---|---|---|
| **D-5.1** | `/tmp/pg_cleanup.sh` **não existia** (perda de ambiente), embora `install_clean.sh` o invoque | alta (quebra o fluxo) | **corrigido por restauração rastreável** |
| **D-5.7** | `pg_cleanup.sh` executa `DROP OWNED BY <papel> CASCADE` em **todos os bancos do cluster**, não só nos de teste | **crítica** | **documentado, NÃO corrigido** (fora do escopo autorizado) |
| **D-5.9** | Relatório R38 afirmava "1 de 20 chamadas usa superuser"; a contagem real do fluxo é **2 de 30** | média (honestidade) | **corrigido neste relatório** |
| **D-6** | prova negativa rodava antes de existir banco/schema; passava por erro de conexão | **alta** | **corrigido e provado por regressão** |
| **D-7** | seção 4 do `install_clean.sh` não verificava status; instalação perdida ⇒ `exit 0` + mensagem de sucesso | **alta** | **corrigido e provado por sabotagem** |
| **D-8** | cabeçalho afirmava "sem SUPERUSER em nenhuma etapa" — falso | média (honestidade) | **corrigido** |

---

## 1. D-6 — prova negativa de INHERIT

### 1.1 O defeito

```bash
105  GRANT nexus_migrator TO nexus_infra WITH SET TRUE, INHERIT FALSE;
108  $PSQL -X $HBOOT -d $DB -q -c "CREATE TABLE nexus.prova_infra(i int);" && { bad …; exit 1; }
110  ok "prova negativa: …"
112  $PSQL -X … -c "CREATE DATABASE $DB OWNER nexus_migrator;"
122  run_with_ctx nexus_migrator "00001_initial_schema" …
```

Na linha 108: o banco **não existe** (criado na 112) e o schema `nexus` **não existe**
(criado no `00001`, na 122). Medido:

| cenário | exit | causa |
|---|---|---|
| `CREATE TABLE` em banco **inexistente** | **2** | `FATAL: database "nexus_test" does not exist` |
| `CREATE TABLE` com banco e schema, sem privilégio | **1** | `ERROR: permission denied for schema nexus` |

Exit ≠ 0 nos dois casos ⇒ a asserção `… && { bad; exit 1; }` **passava de qualquer forma**.
Prova direta: injetei `INHERIT TRUE` (regressão de D-3) e a linha 108 imprimiu `OK`.

### 1.2 A correção

A prova foi **movida** para imediatamente após `00001_initial_schema.sql` e transformada em função
com três verificações independentes:

1. **Pré-condição explícita:** `SELECT count(*) FROM pg_namespace WHERE nspname='nexus'` tem de
   retornar `1`. Sem isso, `permission denied for schema` seria indistinguível de `schema does not exist`.
2. **SQLSTATE exigido:** `psql -c "\set VERBOSITY verbose" -c "CREATE TABLE nexus.prova_infra(i int);"`,
   extraindo `42501` da mensagem. **Qualquer outro código — incluindo vazio, que é o caso de falha de
   conexão — é rejeitado como INCONCLUSIVO.**
3. **Confirmação de efeito:** `SELECT count(*) … relname='prova_infra'` tem de ser `0`.

**Ponto de honestidade sobre a precondição (2).** `run_with_ctx` **não** aborta o script quando uma
migration falha — ela registra `FALHA` e o fluxo continua (verificado: após `FALHA 00003`, as
migrations `00004`..`00007` ainda rodaram). Portanto a prova **não herda** o sucesso da `00001`:
ela revalida a existência do schema por conta própria e devolve `INCONCLUSIVO` se ele não existir.
A precondição é **verificada**, não presumida.

A ordem das três precondições exigidas na especificação é respeitada:

```
(1) CREATE DATABASE nexus_test      → seção 1, linha 114
(2) 00001_initial_schema.sql        → linha ~127 (run_with_ctx)
(3) schema `nexus` criado           → verificado em runtime pela pré-condição
```

### 1.3 Validação da extração de SQLSTATE (antes de confiar nela)

| caso | exit | SQLSTATE extraído | veredito |
|---|---|---|---|
| DDL negado por privilégio | 1 | **`42501`** | aceito |
| banco inexistente | 2 | **`` (vazio)** | **rejeitado** |

### 1.4 Prova normal (estado correto)

```
   OK    D-6 prova negativa: DDL direto recusado com SQLSTATE 42501 e nenhuma tabela criada
```

### 1.5 Prova de regressão

```
0. estado da membership:
   nexus_infra | nexus_migrator | admin=t | set=f | inherit=f
   nexus_infra | nexus_migrator | admin=f | set=t | inherit=f

1. injetar INHERIT TRUE:
   REVOKE nexus_migrator FROM nexus_infra CASCADE;
   GRANT  nexus_migrator TO nexus_infra WITH SET TRUE, INHERIT TRUE;
   → nexus_infra | nexus_migrator | admin=f | set=t | inherit=t

2. nexus_infra consegue DDL indevido?
   $ psql -U nexus_infra -d nexus_test -c "CREATE TABLE nexus.prova_regressao(i int);"
   CREATE TABLE                                    ← a regressão ESTÁ ativa

3. executar a prova D-6 com a regressão ativa:
   FALHA D-6 REGRESSAO: nexus_infra EXECUTOU DDL direto (herdou privilegios de nexus_migrator)
   exit=1                                          ← DETECTADA

4. restaurar INHERIT FALSE:
   REVOKE nexus_migrator FROM nexus_infra CASCADE;
   GRANT  nexus_migrator TO nexus_infra WITH SET TRUE, INHERIT FALSE;
   → nexus_infra | nexus_migrator | admin=f | set=t | inherit=f

5. confirmar:
   DDL direto          → ERROR: permission denied for schema nexus
   SET ROLE migrator   → SET / RESET
   prova D-6 normal    → OK … SQLSTATE 42501 … exit=0
```

**A mutação não ficou aplicada.** O estado final do cluster tem `inherit_option = f`, verificado
por consulta a `pg_auth_members` e por efeito (DDL negado, `SET ROLE` permitido).

---

## 2. D-5 — auditoria do cleanup

### 2.1 Divergência `/tmp` × versionado

| arquivo | estado no início do R39 | MD5 |
|---|---|---|
| `/tmp/pg_cleanup.sh` | **AUSENTE** | — |
| `docs/r38/scripts/pg_cleanup.sh` | presente | `6a9abfacee4dd3aa723159dee76ac7c8` |
| `docs/r35/pg_cleanup.sh` | presente | `6a9abfacee4dd3aa723159dee76ac7c8` |

**Explicação:** não houve edição divergente — houve **perda do arquivo de trabalho** na
reinicialização de `/tmp`. Os dois artefatos versionados são **byte a byte idênticos**
(`cmp` → sem saída; `sha256` `4d866aeb…` em ambos).

**Correção rastreável:** `install -m 0755 docs/r38/scripts/pg_cleanup.sh /tmp/pg_cleanup.sh`.
Depois: `/tmp`, `r38` e `r35` com **o mesmo MD5** `6a9abfacee4dd3aa723159dee76ac7c8`.

### 2.2 Inventário de conexões (todas como `postgres`)

`HOST="-h 127.0.0.1 -p 55432 -U postgres"` — **10 invocações de `psql`, 100 % como superuser**:

| linha | operação |
|---|---|
| 27 | `DROP DATABASE IF EXISTS <db>` (lista de teste) |
| 33 | `SELECT oid FROM pg_roles` |
| 42 | `SELECT datname FROM pg_database WHERE NOT datistemplate` |
| 43 | `SELECT count(*) FROM pg_shdepend` (por banco) |
| **46** | **`DROP OWNED BY <papel> CASCADE`** (por banco) |
| 51 | `DROP ROLE <papel>` |
| 59 | `DROP DATABASE IF EXISTS <db>` (2ª tentativa) |
| 63 | `DROP ROLE <papel>` (2ª tentativa) |
| 72 | relatório de papéis |
| 75 | relatório de bancos |

### 2.3 Inventário de operações destrutivas

| operação | ocorrências | escopo |
|---|---|---|
| `DROP ROLE` | 2 (linhas 51, 63) | apenas os papéis em `$ROLES` |
| `DROP DATABASE` | 2 (27, 59) | apenas `$TEST_DATABASES` = `nexus_test nexus_prov_test nexus_preexist_test probe_db` — **mais** um filtro `case` na 2ª tentativa |
| `DROP OWNED … CASCADE` | **1 (linha 46)** | **TODOS os bancos não-template — sem filtro** |
| `REASSIGN OWNED` | 0 | — |
| `GRANT` | 0 | — |
| `TRUNCATE` / `DELETE` / `ALTER` | 0 | — |

### 2.4 O vazamento de escopo — **prova**

A linha 42 percorre `pg_database WHERE NOT datistemplate`; a linha 46 executa `DROP OWNED` em
**cada** um desses bancos. O filtro `$TEST_DATABASES` só é consultado nas linhas 57-62, para decidir
se o **banco** pode ser derrubado — ele **não protege** o `DROP OWNED`.

**Evidência 1 — objeto em banco não-teste é destruído**

```
sentinela_prod (NÃO está em TEST_DATABASES)
  ANTES : public.dado_do_alvo → 1 tabela, 2 linhas
  AÇÃO  : /tmp/pg_cleanup.sh alvo_teste
  DEPOIS: public.dado_do_alvo → 0 tabelas          ← DESTRUÍDA
  script reportou: "DROP ROLE: DROP ROLE"  (sucesso)
```

**Evidência 2 — contraste controlado**

```
papel alvo2 com um objeto em CADA banco:
  nexus_test.t_teste    (DE TESTE)  ANTES=1 → banco derrubado (previsto)
  sentinela_dev.t_dev   (NÃO-teste) ANTES=1 → DEPOIS=0     ← tabela destruída
```

Detalhe da execução:

```
== 2. papel por papel: identificar bancos com dependencias, limpar, dropar ==
   --- alvo_teste (oid 16386) ---
     [postgres]        1 dependencia(s)
     [sentinela_dev]   1 dependencia(s)
     [sentinela_prod]  1 dependencia(s)
     DROP ROLE: DROP ROLE
```

### 2.5 Por que isso importa

`install_clean.sh` invoca:

```bash
/tmp/pg_cleanup.sh nexus_migrator nexus_app nexus_anonymous nexus_audit_writer nexus_infra
```

`nexus_migrator` é **dono do schema `nexus` inteiro**. Rodar esse script contra um cluster que
contenha **qualquer** outro banco onde `nexus_migrator` seja dono de objetos — outro ambiente, um
snapshot, produção — **destrói esses objetos**, sem aviso e reportando sucesso.

No ambiente atual é inócuo (só existe `postgres`). **Como script entregue, não é.**

### 2.6 Erros ocultados no cleanup

Encontrados **3 pontos** em que falha é engolida:

| linha | código | efeito |
|---|---|---|
| 43 | `… 2>/dev/null` | erro de leitura de `pg_shdepend` vira `n` vazio ⇒ tratado como `0` |
| **46** | `DROP OWNED BY $r CASCADE; >/dev/null 2>&1` | **falha do `DROP OWNED` é invisível** |
| 59 | `DROP DATABASE … >/dev/null 2>&1` | falha do 2º `DROP DATABASE` é invisível |

Além disso, `set -u` mas **sem `set -e`/`set -o pipefail`**, e o script **sempre sai 0**: a única
saída de erro é a string `AINDA PENDENTE` no stdout, que só o chamador interpreta.

### 2.7 Correção proposta (não aplicada)

```bash
# linha 42 -> iterar SOMENTE os bancos de teste
for db in $TEST_DATABASES; do
  ...
  $PSQL -X $HOST -d "$db" -q -v ON_ERROR_STOP=1 -c "DROP OWNED BY $r CASCADE;" \
    || { echo "     FALHA DROP OWNED em $db"; exit 1; }
done
# bancos fora da lista: apenas DETECTAR e RECUSAR, nunca DROP OWNED
```

**Não aplicada** porque alterar o comportamento do cleanup é mudança de escopo operacional e a
instrução foi "não executar limpeza adicional até demonstrar o escopo" — demonstrado aqui, mas a
correção precisa de autorização explícita.

---

## 3. Contagem corrigida de invocações superuser

| componente | conexões | como `postgres` |
|---|---|---|
| `install_clean.sh` | 20 | **1** (criar `nexus_infra`) |
| `pg_cleanup.sh` (1 invocação) | 10 | **10** |
| **TOTAL do fluxo** | **30** | **11** |

O relatório R38 afirma "1 de 20 chamadas usa superuser". **Isso está errado por omissão:** conta só
o `install_clean.sh` e ignora as 10 conexões do `pg_cleanup.sh` que ele invoca.

- **1 de 20** — correto apenas para `install_clean.sh`, isolado.
- **11 de 30** — correto para o fluxo completo.

`test_runtime_isolation.sh` faz **6 conexões como `postgres`**, mas é *ferramenta de prova*, não
faz parte do fluxo de instalação.

---

## 4. Revisão de propagação de erros

### 4.1 O que já estava correto

| verificação | resultado |
|---|---|
| `\|\| true` | **0 ocorrências** |
| `2>/dev/null` em etapa com asserção | **0** (só resta em comentário) |
| `$?` após pipe em asserção | **0** — captura via `out=$(…); rc=$?` |
| falha em migration | `exit=1`, `FALHA 00003_persistence_integrity` |
| falha em `ALTER SCHEMA public` | `exit=1` |
| falha em `GRANT SET nexus_app` | `exit=1` |
| falha no cleanup | `exit=1` |

### 4.2 D-7 — a seção 4 não verificava nada

Cinco consultas de resultado sem checagem de status. Sabotagem (drop do banco antes da seção 4):

```
ANTES da correção:  exit=0
                    "== INSTALACAO LIMPA: SEM SUPERUSER EM NENHUMA ETAPA =="
DEPOIS da correção: exit=1
                    "FALHA consulta de resultado falhou (tabelas nexus): FATAL: database does not exist"
                    "FALHA esperava 27 tabelas em nexus"
                    …
                    "== 5 FALHA(S) =="
```

A correção introduziu a função `consulta` (status verificado) **e** conferiu as contagens contra o
retrato esperado: `27` tabelas, `20` FORCE RLS, `49` policies, `56` FKs, dono
`nexus_audit_writer`. Uma instalação parcial (**por exemplo, 0 tabelas**) agora **falha**, quando
antes era reportada como sucesso.

### 4.3 Etapas que continuam após falha (mantido, com justificativa)

Quando `CREATE ROLE nexus_audit_writer` falha, o script **prossegue** e acumula falhas:

```
   FALHA CREATE ROLE
   FALHA GRANT SET
   FALHA GRANT schema a writer
   FALHA 00007_tool_grants_and_preferences
   FALHA bootstrap.sql
== 5 FALHA(S) ==   exit=1
```

Isso é **intencional e correto**: o objetivo é produzir o diagnóstico completo de uma vez, e o
`exit` final é 1. Não é falha engolida — todas as 5 são impressas e contabilizadas.

### 4.4 D-8 — cabeçalho corrigido

De: `R36 — INSTALACAO LIMPA com TRES PAPEIS SEPARADOS, sem SUPERUSER em nenhuma etapa.`
Para: declaração precisa, listando o que é provado e a **exceção explícita** (1 comando como
`postgres`) e a **dívida conhecida** (`pg_cleanup.sh` conecta como `postgres` 10×).

A mensagem final também mudou:

- antes: `== INSTALACAO LIMPA: SEM SUPERUSER EM NENHUMA ETAPA ==` (sempre impressa)
- agora: `== INSTALACAO LIMPA: nenhuma etapa executou como SUPERUSER (exceto o bootstrap do 1o papel) ==`
  — **só** quando `FAILS == 0`

---

## 5. Resultados após as correções

| verificação | resultado |
|---|---|
| instalação limpa | **exit 0**, 29 asserções `OK`, 0 `FALHA` |
| D-6 prova normal | **OK** (`SQLSTATE 42501`, nenhuma tabela criada) |
| D-6 prova de regressão | **DETECTADA** (`REGRESSAO`, exit 1) |
| D-7 seção 4 sabotada | **detectada** (era `exit 0`, agora `exit 1`) |
| catálogo | 27 tabelas · 20 FORCE RLS · 49 policies · 56 FKs · dono `nexus_audit_writer` |
| isolamento do runtime | **28/28** |
| sabotagem dos verificadores | **5/5** |
| testes de integração | **21/21** (como `nexus_app`) |
| `INHERIT FALSE` restaurado | **sim** — `inherit_option = f`, DDL negado, `SET ROLE` ok |

---

## 6. Arquivos alterados e novos

### 6.1 Alterado (único arquivo de código/script)

| arquivo | MD5 anterior (R38) | MD5 atual | finalidade |
|---|---|---|---|
| `docs/r38/scripts/install_clean.sh` | `af409a9b39ec196e9d51e4d02a9ff059` | *(ver §6.4)* | D-6, D-7, D-8 |

Nenhuma migration, nenhum verificador, nenhum código de runtime foi tocado.

### 6.2 Novos (artefatos R39)

```
docs/r39/RELATORIO_R39.md                    este relatório
docs/r39/PROVA_D5_vazamento_de_escopo.md     prova do vazamento de escopo
docs/r39/diffs/install_clean.diff            diff R38 → R39 (82 linhas)
docs/r39/logs/instalacao.log                 instalação final: 29 OK, 0 FALHA
docs/r39/logs/isolamento.log                 28/28
docs/r39/logs/sabotagem.log                  5/5
docs/r39/logs/vitest.log                     21/21
docs/r39/logs/d7-secao4-sabotada.log         D-7 antes/depois
docs/r39/logs/d7-writer-falha.log            cascata de falhas (exit 1)
docs/r39/logs/d7-00003-falha.log             falha de migration (exit 1)
docs/r39/logs/d5-cleanup-escopo.log          execução do cleanup com alvo injetado
docs/r39/MANIFEST_r39.md5                    manifesto dos 33 artefatos
```

### 6.3 Preservação

`docs/r35/` e `docs/r38/` **não foram removidos nem reescritos**, exceto o `install_clean.sh` (que
teve sua versão anterior preservada em `/tmp/ic_orig.sh` e cujo diff integral está em
`docs/r39/diffs/install_clean.diff`).

### 6.4 Hashes finais (após a última correção de comentário)

```
809412d29e7cafbdb299e0f97afeacc4  docs/r38/scripts/install_clean.sh
fa6c3b6280616bfb384e403e3dc0016a  docs/r39/diffs/install_clean.diff
```

O hash anterior (`f67c7b08…`) corresponde ao estado intermediário, antes de corrigir um comentário
que afirmava, incorretamente, que `run_with_ctx` abortava o script. **Os dois hashes ficam
registrados** para rastreabilidade; o vigente é `809412d2…`, reexecutado com 29 OK / 0 FALHA.

---

## 7. O que **não** está resolvido

1. **D-5.7 — vazamento de escopo do `pg_cleanup.sh`.** Provado, não corrigido. É a pendência mais
   grave aberta e precisa de autorização para correção.
2. **11 conexões como `postgres`** no fluxo completo (1 inevitável + 10 do cleanup). Reduzir para 1
   exige corrigir o item 1.
3. **Divergência `/tmp` × versionado** foi resolvida por restauração, mas o fluxo continua
   dependendo de `/tmp` — os scripts deveriam ser invocados por caminho versionado, não por `/tmp`.
4. **D-7 continua presente em outras etapas?** Auditei as 30 conexões: as demais têm status
   verificado. Permanecem **sem** verificação explícita apenas as duas consultas de relatório do
   `install_clean.sh` (linhas de "atributos dos papéis"), que agora têm `rc` checado.

---

## 8. Conclusão

D-6 está **corrigido e provado nos dois sentidos** (normal e sabotado). D-7 e D-8 estão corrigidos e
provados por sabotagem. D-5 revelou **dois problemas maiores**: um arquivo ausente e um **vazamento
de escopo destrutivo** que não foi corrigido por estar fora do escopo autorizado.

**Não declaro a Fase 5.1 aprovada.** A decisão depende de aceitar — ou mandar corrigir — o
item D-5.7.
