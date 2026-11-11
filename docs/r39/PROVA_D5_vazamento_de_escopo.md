# D-5.7 — PROVA: `pg_cleanup.sh` atinge bancos FORA do escopo declarado

**Data:** R39 · **Ambiente:** PostgreSQL 17.11, cluster descartável `127.0.0.1:55432`
**Script auditado:** `docs/r38/scripts/pg_cleanup.sh` (MD5 `6a9abfacee4dd3aa723159dee76ac7c8`)

## O defeito

Linha 42 itera **todos** os bancos não-template:

```bash
for db in $($PSQL ... "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1;"); do
  ...
  # linha 46 — SEM filtro de TEST_DATABASES
  $PSQL -X $HOST -d "$db" -q -c "DROP OWNED BY $r CASCADE;" >/dev/null 2>&1
done
```

O filtro `TEST_DATABASES` existe, mas **só é usado na segunda tentativa** (linhas 56-62), para
decidir se o *banco* pode ser derrubado. Ele **não** protege o `DROP OWNED` da linha 46.

`DROP OWNED BY <papel> CASCADE`, executado em um banco, **destrói todos os objetos de que aquele
papel é dono naquele banco** — inclusive `DROP TABLE` de dados de produção — e ainda revoga seus
privilégios ali.

## Evidência 1 — objeto em banco não-teste é destruído

```
Banco sentinela_prod (NÃO está em TEST_DATABASES)
  ANTES : public.dado_do_alvo  → 1 tabela, 2 linhas
  AÇÃO  : /tmp/pg_cleanup.sh alvo_teste
  DEPOIS: public.dado_do_alvo  → 0 tabelas          ← DESTRUÍDA
  O script reportou: "DROP ROLE: DROP ROLE"  (sucesso)
```

## Evidência 2 — contraste controlado (teste vs não-teste)

```
papel alvo2 com um objeto em CADA banco:
  nexus_test.t_teste      (banco DE TESTE)     ANTES=1  → banco derrubado (previsto)
  sentinela_dev.t_dev     (banco NÃO-teste)    ANTES=1  → DEPOIS=0  ← tabela destruída
```

## Por que isso importa para a entrega

O `install_clean.sh` invoca:

```bash
/tmp/pg_cleanup.sh nexus_migrator nexus_app nexus_anonymous nexus_audit_writer nexus_infra
```

`nexus_migrator` é **dono do schema `nexus` inteiro**. Se esse script for executado contra um
cluster que contenha **qualquer** outro banco onde `nexus_migrator` seja dono de objetos — outro
ambiente, um banco de produção, um snapshot — **todos esses objetos serão destruídos**, sem aviso
e reportando sucesso.

No ambiente de teste atual isso é inócuo (só existe `postgres`). **Não é inócuo como script
entregue**: é uma arma carregada apontada para "todos os bancos do cluster".

## Correção necessária (não aplicada nesta rodada — aguarda decisão)

Restringir o `DROP OWNED` aos bancos de teste:

```bash
for db in $TEST_DATABASES; do
  # e nada mais
```

Se for necessário detectar dependências em outros bancos, **listar** (SELECT em `pg_shdepend`) e
**recusar** com diagnóstico — nunca executar `DROP OWNED` fora da lista.
