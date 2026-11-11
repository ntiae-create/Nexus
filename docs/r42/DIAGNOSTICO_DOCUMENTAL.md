# R42 — Diagnóstico documental (correções propostas, NÃO aplicadas)

Três artefatos descrevem o mecanismo de falha da exclusão do owner de forma **factualmente
incorreta**. Nenhum foi alterado nesta etapa: a autorização do R42 cobre **exclusivamente a
asserção de `migrations.test.ts`**. Este documento apresenta o texto proposto para cada um, com a
evidência que o fundamenta, para autorização adicional.

**Fatos medidos** (cluster descartável, PG 17.11, banco `nexus_test` completamente instalado):

```
record_deleted_entity | SECURITY DEFINER=true | dono=nexus_migrator
postgres             | super=true  | bypassrls=true
nexus_migrator       | super=false | bypassrls=false
tombstones           | rls=true    | force=true
```

SQLSTATE observado na tentativa de `DELETE FROM nexus.owner_identity` com dados presentes:

| runner | SQLSTATE | mensagem |
|---|---|---|
| `postgres` | **42501** | `new row violates row-level security policy for table "tombstones"` |
| `nexus_migrator` | **42501** | idem |
| `nexus_app` | **42501** | `permission denied for table owner_identity` |

---

## Item 1 — Comentário afirma que runner SUPERUSER produz 23503

**Arquivo:** `packages/database/tests/postgres/verify-stage-5-owner-deletion.sql`
**Linhas:** 315-317

### Texto atual

```sql
  --   * runner SUPERUSER: ignora RLS; o INSERT em `tombstones` feito pelo trigger
  --     `record_deleted_entity` chega a rodar e viola `tombstones_owner_id_fkey` -> 23503.
```

### Por que está errado

O `INSERT` em `tombstones` **não é executado pelo runner**. É executado dentro do trigger
`record_deleted_entity`, que é `SECURITY DEFINER` e portanto roda com os privilégios do **seu dono**
— `nexus_migrator` —, não do runner. Os atributos `rolsuper`/`rolbypassrls` do **runner** são
irrelevantes para a RLS aplicada dentro da função.

Medido: o runner `postgres` (superuser + bypassrls) recebe **42501**, não 23503.

Prova isolada do mecanismo (tabela descartável com FORCE RLS + policy `WITH CHECK (false)`):

| caminho | resultado |
|---|---|
| `INSERT` **direto** como `postgres` | **passa** — superuser ignora RLS |
| `INSERT` **dentro** de função `SECURITY DEFINER` de dono sem bypassrls | **`permission denied`** |

### Texto proposto

```sql
  -- A falha vem sempre do MESMO ponto: o INSERT em `tombstones` feito pelo trigger
  -- `record_deleted_entity`, que e SECURITY DEFINER e executa como seu dono `nexus_migrator`
  -- (rolsuper=f, rolbypassrls=f). Como `tombstones` tem FORCE ROW LEVEL SECURITY, a policy barra o
  -- INSERT antes de a FK `tombstones_owner_id_fkey` ser avaliada. Por isso o SQLSTATE e 42501 e o
  -- 23503 e inalcancavel por construcao — qualquer que seja o papel do runner.
```

---

## Item 2 — Comentário identifica o dono do trigger como `postgres`

**Arquivo:** `packages/database/tests/postgres/verify-stage-5-owner-deletion.sql`
**Linha:** 318

### Texto atual

```sql
  --   * runner NAO-superuser (o caso de PRODUCAO, ver R36): o trigger tambem e SECURITY DEFINER
  --     com dono `postgres`, mas a tabela `tombstones` tem FORCE RLS e o INSERT nao tem contexto
  --     coerente para o dono excluido -> 42501 (row-level security).
```

### Por que está errado

`pg_proc.proowner` do trigger `record_deleted_entity` é **`nexus_migrator`**, não `postgres`:

```
record_deleted_entity | SECURITY DEFINER=true | dono=nexus_migrator
```

A conclusão do parágrafo (SQLSTATE 42501) está **correta**; apenas a identificação do dono está
errada. E a premissa "runner não-superuser" é irrelevante: o 42501 também ocorre com runner
superuser (ver Item 1).

### Texto proposto

```sql
  --   * Como o dono do trigger (`nexus_migrator`) nao tem BYPASSRLS e `tombstones` usa FORCE RLS,
  --     a policy barra o INSERT -> 42501 (row-level security). Isso vale para runner superuser e
  --     nao-superuser igualmente, porque a RLS e avaliada no contexto do DONO da funcao.
```

---

## Item 3 — Documentação da Fase 5 afirma `SQLSTATE 23503`

**Arquivo:** `docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md`
**Linha:** 604

### Texto atual

```markdown
| Excluir **definitivamente o owner**, com dados presentes | ❌ **impossível hoje** — falha com
`SQLSTATE 23503` em `tombstones_owner_id_fkey` | `verify-stage-5-owner-deletion.sql` §3 |
```

### Por que está errado

Medido: o SQLSTATE real é **42501** (RLS em `tombstones`), em todos os runners. O 23503 não ocorre.
A afirmação também contradiz o próprio verificador citado como fonte (`§3`), que desde o R38 aceita
`('23503', '42501')` e valida a origem de cada um.

O restante da linha está correto e deve ser preservado: a exclusão definitiva do owner com dados
presentes **é impossível hoje**, e isso é um defeito real — não uma limitação de teste.

### Texto proposto

```markdown
| Excluir **definitivamente o owner**, com dados presentes | ❌ **impossível hoje** — falha com
`SQLSTATE 42501` (FORCE RLS em `tombstones`, aplicada no contexto do dono `nexus_migrator` do
trigger `SECURITY DEFINER`) | `verify-stage-5-owner-deletion.sql` §3 |
```

---

## Resumo

| item | arquivo | linha | defeito | corrigido nesta etapa? |
|---|---|---|---|---|
| 1 | `verify-stage-5-owner-deletion.sql` | 315-317 | atribui 23503 a runner superuser | **não** — aguarda autorização |
| 2 | `verify-stage-5-owner-deletion.sql` | 318 | dono do trigger dito `postgres` (real: `nexus_migrator`) | **não** — aguarda autorização |
| 3 | `docs/FASE_5_G13_…md` | 604 | afirma `SQLSTATE 23503` (real: 42501) | **não** — aguarda autorização |

**Impacto de não corrigir:** são comentários e documentação — não afetam execução nem segurança.
Mas registram um modelo mental errado do mecanismo, o que induz a erro quem for revisar ou evoluir
o verificador. Os itens 1 e 2 estão no mesmo arquivo e podem ser corrigidos juntos.

**Observação sobre o item 1:** o código do verificador está **correto e mais estrito** que a
justificativa escrita ao lado dele. A correção é só de texto; nenhuma validação seria removida.
