# R40 — Inventário das operações destrutivas (pós-correção)

Todas as conexões do `pg_cleanup.sh` usam `HOST="-h 127.0.0.1 -p 55432 -U postgres"`, ou seja,
**papel `postgres` (superuser)**. A coluna "banco" é o banco de conexão; a coluna "afeta" é o que a
operação pode destruir.

## Operações destrutivas (as únicas que alteram estado)

| # | linha | operação | banco de conexão | afeta | critério de seleção | proteção contra escopo externo |
|---|---|---|---|---|---|---|
| 1 | 197 | `DROP OWNED BY "<r>" CASCADE` | cada `$db` de **TEST_DATABASES** | objetos do papel `$r` **naquele banco** | `$r` vem da linha de comando, validado por regex; `$db` vem de `TEST_DATABASES` | laço itera **somente** `TEST_DATABASES`; `is_test_db` confirma antes de conectar; existe consulta prévia de existência do banco |
| 2 | 214 | `DROP DATABASE IF EXISTS "<db>" WITH (FORCE)` | `postgres` | o banco `$db` inteiro | `$db` de `TEST_DATABASES` | laço itera **somente** `TEST_DATABASES`; `W` valida nome |
| 3 | 232 | `DROP ROLE "<r>"` | `postgres` | o papel `$r` no cluster | `$r` da linha de comando | papel só entra em `papel_para_limpar` se o **pré-voo** não achou dependência fora do escopo |

## Operações de leitura (nenhuma altera estado)

| linha | consulta | finalidade |
|---|---|---|
| 99 | `SELECT oid FROM pg_roles WHERE rolname='$r'` | descobrir se o papel existe |
| 110 | `SELECT datname, count(*) FROM pg_shdepend ... WHERE refobjid='$oid' GROUP BY dbid` | **pré-voo:** mapear onde o papel tem dependências (com filtro por `dbid`) |
| 122 | `SELECT datname FROM pg_database WHERE datdba='$oid'` | pré-voo: o papel é dono de algum banco? |
| 188 | `SELECT count(*) FROM pg_database WHERE datname='$db'` | o banco de teste existe? (evita erro de conexão mascarado) |
| 247 | `SELECT count(*) FROM pg_roles WHERE rolname='$r'` | o papel foi removido de fato? |
| 251 | `SELECT datname FROM pg_database ...` | relatório final |
| 254 | `SELECT rolname FROM pg_roles ...` | relatório final |

## Operações **ausentes** (verificado por grep)

| operação | ocorrências | observação |
|---|---|---|
| `DROP SCHEMA` | **0** | não existe — schemas caem via `DROP OWNED`/`DROP DATABASE` |
| `REASSIGN OWNED` | **0** | não existe |
| `GRANT` | **0** | a correção **não** concede privilégio algum |
| `REVOKE` | **0** | a correção **não** revoga privilégio algum |
| `ALTER` | **0** | não existe |
| `TRUNCATE` / `DELETE` / `UPDATE` | **0** | não existe |
| `|| true` | **0** | não existe |
| `2>/dev/null` | **0** | removido; falhas agora aparecem |

## Operações indiretas por scripts auxiliares

O `pg_cleanup.sh` **não chama outro script**. Quem o chama:
`install_clean.sh`, `test_integrity.sh`, `test_provisioning.sh`, `test_preexisting_role.sh`
(todos em `docs/r35`/`docs/r38`). Nenhum deles é invocado por ele.

## Superuser: necessidade real, medida

Teste empírico com um papel `CREATEDB CREATEROLE` (sem superuser):

| operação | resultado sem superuser |
|---|---|
| `CREATE DATABASE` | **OK** |
| `DROP DATABASE` do próprio banco | **OK** |
| `CREATE ROLE` | **OK** |
| `DROP ROLE` com `ADMIN OPTION` no alvo | **OK** |
| `DROP OWNED` em banco de terceiro | **BLOQUEADO** — `Only roles with privileges of role "X" may drop objects owned by it` |

**Conclusão:** as operações destrutivas **não exigem superuser por natureza**. As 16 conexões como
`postgres` poderiam cair para 0 em superuser **se** (a) o executor recebesse `ADMIN OPTION` sobre
os papéis-alvo e (b) fosse dono dos bancos de teste. Isso exige mudar o **provisionamento**
(quem cria os papéis e os bancos), o que está fora do escopo autorizado do R40. **Não foi feito.**
