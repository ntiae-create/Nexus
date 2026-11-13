# Instalação segura do banco PostgreSQL de produção

Este runbook descreve o instalador existente em `packages/database/scripts/production/`.
Ele não altera a arquitetura, não chama os CLIs do Railway/Vercel e não configura
variáveis nem dispara deploys. A execução contra um banco real é uma ação separada
do operador; nenhum passo deste trabalho conectou aos serviços de produção.

> **Escopo:** provisionar papéis, aplicar as migrations, conceder os privilégios
de runtime previstos e verificar os invariantes do banco. A conexão da aplicação
e qualquer alteração de infraestrutura são etapas externas a este instalador.

---

## 1. O que o instalador faz

| Ordem | Conexão | Arquivo/etapa | Efeito |
|---|---|---|---|
| 1 | `postgres` (administrador) | `00_preflight.sql` + `migrate.sh --check-only` | Só leitura: valida requisitos, papéis, ownership, privilégios efetivos e estado do ledger. O runner usa um advisory lock transitório durante a leitura. |
| 2 | `postgres` | `00_prepare.sql` | Repete o preflight; cria somente papéis ausentes e concede as permissões administrativas mínimas. Não altera atributos de papéis existentes nem muda ownership. |
| 3 | `postgres` | `psql \password` iniciado pelo instalador, quando necessário | Define senhas apenas para logins recém-criados ou com `--rotate-passwords` explícito. Senhas existentes são preservadas por padrão. |
| 4 | `nexus_migrator` | `migrate.sh` | Aplica ou verifica as oito migrations e registra SHA-256 no ledger. |
| 5 | `nexus_migrator` | `20_grant_runtime.sql` | Concede a allowlist de privilégios de runtime a `nexus_app`; não revoga privilégios. |
| 6 | `nexus_migrator` | `30_verify.sql` | Confirma ledger, ownership, papéis, RLS, policies e allowlist efetiva. Qualquer invariante obrigatório divergente causa erro e exit code diferente de zero. |

O administrador não executa migrations. `nexus_migrator` não é superuser,
não tem `BYPASSRLS`, `CREATEDB` nem `CREATEROLE`; sua única membership prevista
permite `SET ROLE nexus_audit_writer` sem herança nem ADMIN OPTION. `nexus_app`
não tem memberships e não é dono de objetos.

O instalador não executa `DROP`, `REASSIGN OWNED` nem reparos automáticos de
ownership/ACL. Se encontrar configuração preexistente divergente, falha para
revisão em vez de removê-la silenciosamente.

---

## 2. Pré-requisitos e conexão

- Execute de um terminal confiável, de forma interativa, com o cliente `psql`
  instalado e acesso administrativo PostgreSQL ao banco-alvo.
- Use o host TCP, a porta e o nome do banco exatos. **Não** forneça uma URL de
  conexão, senha em argumento, `PGPASSWORD` ou `NEXUS_MIGRATION_DATABASE_URL`.
- TLS é obrigatório. O padrão é `PGSSLMODE=require`; também são aceitos
  `verify-ca` e `verify-full` quando a CA/certificado do servidor está configurada.
- O administrador usado pelo script é `postgres`. O papel precisa ser
  superuser (ou ter as capacidades verificadas pelo preflight) e ser owner do
  banco, exceto quando superuser.
- O script requer PostgreSQL 16 ou superior.
- `PGDATABASE` deve conter apenas letras, dígitos, ponto, underscore ou hífen;
  `PGHOST` deve ser hostname/endereço, não URL. A instalação usa TCP.

Confirme o destino por um canal operacional autorizado antes de executar:

```sh
cd /caminho/para/Nexus

PGHOST=host-do-postgres \
PGPORT=5432 \
PGDATABASE=nome-do-banco \
PGSSLMODE=require \
  sh packages/database/scripts/production/install-production.sh
```

O comando pede a senha do administrador com entrada oculta. Não cole senha ou
URL em chat, histórico do shell, variável de ambiente ou linha de comando. Se o
cliente não estiver no `PATH`, `PSQL_BIN` pode apontar para o executável `psql`.

O instalador cria um diretório temporário privado (`umask 077`), usa passfiles
libpq com modo `0600` e remove-os no encerramento, inclusive em falhas tratadas.
Ele não coloca senhas em `argv`, `PGPASSWORD`, SQL visível, logs ou URLs. Isso
não substitui o armazenamento seguro das credenciais pelo operador nem garante
apagamento criptográfico da memória/disco do sistema.

---

## 3. Senhas e opções explícitas

### Comportamento padrão

- A senha administrativa é pedida a cada execução e não é salva pelo instalador.
- Se `nexus_migrator` ou `nexus_app` ainda não existia, o instalador cria o
  respectivo login e `psql` pede a nova senha duas vezes, sem eco.
- Se o papel já existia, a senha existente não é alterada. O instalador pede a
  senha atual de `nexus_migrator` para abrir a conexão das migrations.
- A senha de `nexus_app` não é impressa nem recuperável pelo script. Registre a
  nova senha diretamente em um gerenciador de segredos apropriado antes de
  continuar; qualquer uso posterior pela aplicação é uma etapa separada.

O instalador não impõe comprimento mínimo de senha. Escolha senhas únicas,
fortes e armazenadas em gerenciador de segredos. O comando `\password` evita
colocar a senha em texto claro no comando SQL, no histórico ou nos argumentos do
processo; o tipo de verificador armazenado depende da configuração
`password_encryption` do servidor.

### Rotacionar senhas

Use `--rotate-passwords` somente quando a rotação for intencional e coordenada
com os consumidores das credenciais:

```sh
PGHOST=host-do-postgres PGPORT=5432 PGDATABASE=nome-do-banco PGSSLMODE=require \
  sh packages/database/scripts/production/install-production.sh --rotate-passwords
```

A opção rotaciona `nexus_migrator` e `nexus_app` na mesma transação administrativa.
Depois, o instalador pede novamente a senha nova de `nexus_migrator` para a fase
de migrations. Planeje a atualização do consumidor da credencial `nexus_app`
fora deste procedimento. Não combine rotação com adoção de ledger legado.

### Ledger legado

`--adopt-legacy-ledger` é uma recuperação excepcional, não uma opção de
instalação normal. Só é aceito quando existe um ledger legado completo (versões
1–8, sem checksums), e o instalador exige a validação integral por
`30_verify.sql` antes de registrar os checksums dos arquivos atuais. A recuperação
não reexecuta migrations nem altera dados; antes da validação, reaplica somente
os GRANTs conhecidos de `20_grant_runtime.sql`. Esse arquivo apenas concede
privilégios e não remove ACLs inesperadas. Faça backup restaurável e revise o
estado antes de optar por essa recuperação.

```sh
PGHOST=host-do-postgres PGPORT=5432 PGDATABASE=nome-do-banco PGSSLMODE=require \
  sh packages/database/scripts/production/install-production.sh --adopt-legacy-ledger
```

Um ledger parcial sem checksums, com lacunas, nomes divergentes ou checksums
incorretos falha fechado. Não edite o ledger para contornar a checagem.

---

## 4. Backup, restauração e recuperação

Antes de uma adoção de ledger legado, de uma migração de recuperação ou de
qualquer ajuste manual, obtenha um backup restaurável e teste a restauração em
um banco separado. Esta revisão não acessou Railway nem executou backup ou
restauração de produção.

### Backup lógico

Use uma versão de `pg_dump` compatível com a versão principal do servidor. O
formato custom permite validar o catálogo e restaurar com `pg_restore`. O
exemplo pede a senha interativamente: não use URL com credenciais, `PGPASSWORD`
ou senha em argumentos. `PGSSLMODE=require` exige transporte TLS; use
`verify-full` quando a CA e o nome do servidor estiverem configurados.

```sh
umask 077
export PGHOST=host-do-postgres PGPORT=5432 PGDATABASE=nome-do-banco
export PGUSER=postgres PGSSLMODE=require
BACKUP_FILE="$HOME/nexus-pre-change-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --password --file="$BACKUP_FILE" "$PGDATABASE"
chmod 600 "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "$BACKUP_FILE.toc"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"  # macOS: shasum -a 256
chmod 600 "$BACKUP_FILE.toc" "$BACKUP_FILE.sha256"
```

Guarde o arquivo, catálogo e hash em armazenamento de backup aprovado, fora do
repositório. Um `pg_dump` de banco não inclui os papéis globais nem suas senhas;
preserve as credenciais em um gerenciador de segredos e recrie os papéis somente
com os atributos/memberships aprovados. Dumps e metadados podem revelar nomes de
objetos/dados: mantenha controles de acesso e retenção apropriados.

### Restauração de ensaio

Nunca restaure sobre o banco de origem como primeiro teste. Crie um banco vazio
e separado com um nome simples. `00_prepare.sql` valida os papéis existentes,
cria apenas os ausentes e concede ao migrator os privilégios previstos no banco
de destino; `pg_restore` conserva ownership e ACLs do dump, por isso os papéis
referenciados precisam existir antes da restauração.

```sh
RESTORE_DB=nexus_restore_check
export PGHOST=host-do-postgres PGPORT=5432 PGUSER=postgres PGSSLMODE=require

# Usa o banco administrativo apenas para criar o destino.
PGDATABASE=postgres psql --no-psqlrc --password --set ON_ERROR_STOP=1 \
  --command "CREATE DATABASE \"$RESTORE_DB\""

# Com papéis e privilégios preparados, restaura sem --clean, --create,
# --no-owner ou --no-acl: não sobrescreve o original e conserva o contrato.
PGDATABASE="$RESTORE_DB" psql --no-psqlrc --password --set ON_ERROR_STOP=1 \
  --file packages/database/scripts/production/00_prepare.sql
PGDATABASE="$RESTORE_DB" pg_restore --password --exit-on-error \
  --dbname="$RESTORE_DB" "$BACKUP_FILE"

# Executa preflight, confere os checksums, reaplica apenas GRANTs conhecidos,
# pula migrations já registradas e roda a verificação final, sem rotação.
PGDATABASE="$RESTORE_DB" \
  sh packages/database/scripts/production/install-production.sh
```

Todos os comandos acima herdam `PGHOST`, `PGPORT`, `PGUSER=postgres` e
`PGSSLMODE`. Digite a senha administrativa nos prompts. Se a restauração ocorrer
em um cluster novo, `00_prepare.sql` cria os logins sem senha. Antes de rodar
o instalador, abra uma sessão administrativa interativa:

```sh
PGDATABASE=postgres psql --no-psqlrc --password --set ON_ERROR_STOP=1
```

No prompt do `psql`, defina as credenciais e saia; registre-as no gerenciador de
segredos. Não execute estes comandos em um cluster onde as senhas devam ser
preservadas:

```text
\password nexus_migrator
\password nexus_app
\q
```

Não use `--rotate-passwords` para contornar credenciais ausentes: a rotação é
explícita e deve ser coordenada com os consumidores.

Só considere o ensaio válido se `pg_restore` terminar sem erro e o instalador
concluir a verificação de ledger, ownership, memberships, RLS e allowlist. Mantenha
a origem e o backup até a aprovação operacional; cutover de aplicação ou alteração
de infraestrutura são etapas separadas.

### Recuperação de estado divergente

Se uma migration antiga deixou um ledger parcial, se um checksum divergir ou se
a verificação final falhar, não apague schemas nem tente adotar um ledger parcial.
Preserve o estado e os logs sem credenciais, gere/identifique um backup aprovado,
restaure-o em um destino isolado conforme o procedimento acima e valide-o antes
de qualquer decisão sobre a origem. A opção `--adopt-legacy-ledger` é apenas para
as oito migrations completas sem checksum, após `30_verify.sql`; ela não substitui
um backup/restauração.

---

## 5. Transações, ledger e repetição segura

`migrate.sh` exige `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` e um `PGPASSFILE`
legível. O instalador configura essas variáveis internamente. A execução isolada
do runner não aceita `PGPASSWORD` nem `NEXUS_MIGRATION_DATABASE_URL`.

- O runner confere a sequência imutável `00001`–`00008` e compara cada checksum
  SHA-256 do ledger com o arquivo versionado local.
- Um advisory lock PostgreSQL serializa o cheque, DDL e atualização do ledger
  de cada migration.
- `00001` e `00002`, que não abrem transação própria, são encapsuladas pelo
  runner junto da inserção do ledger. `00003`–`00008` mantêm sua transação e o
  runner insere a linha do ledger antes do `COMMIT` final. Assim, DDL e registro
  da versão são confirmados ou revertidos juntos por migration.
- Um erro interrompe o processo; migrations posteriores não começam. Uma
  repetição só pula versões cujo nome e checksum coincidem exatamente.
- Um ledger completo sem checksums requer a opção explícita de adoção acima.
  `migrate.sh --check-only` é um diagnóstico somente-leitura: retorna `10` para
  esse estado legado e zero para um ledger vazio/fresco ou checksummed válido.

Se o banco já recebeu uma tentativa antiga, deixe o instalador executar o
preflight. Não comece aplicando SQL manualmente. Não use `DROP SCHEMA` para
“recomeçar”: isso pode destruir dados e não corrige a causa original.

---

## 6. Resultado esperado da verificação final

`30_verify.sql` é uma verificação executável, não apenas um relatório. Com
`ON_ERROR_STOP`, qualquer falha sai com código diferente de zero e o instalador
não imprime `CONCLUÍDO`. Entre os invariantes conferidos estão:

| Área | Contrato esperado |
|---|---|
| Ledger | Oito versões contíguas, nomes previstos e oito checksums SHA-256 válidos e iguais aos arquivos locais. |
| Estrutura | 27 tabelas em `nexus`, 20 com `FORCE ROW LEVEL SECURITY`, 27 com chave primária e 49 policies esperadas. |
| Dados iniciais | Um único `owner_identity` singleton com o ID previsto; nenhum provider fixture `test-free`/`test-paid`. |
| Papéis | Atributos exatos, sem superuser/BYPASSRLS/replication ou membership inesperada; `nexus_anonymous` não recebe acesso ao schema privado. |
| Ownership | Schema, ledger, relações, tipos e funções pertencem aos papéis previstos; a função de auditoria de tool grants pertence a `nexus_audit_writer`. |
| Runtime | `nexus_app` tem somente os privilégios efetivos da allowlist; não pode alterar o catálogo persistente, forjar auditoria, criar objetos permanentes nem assumir outros papéis. O `TEMPORARY` padrão de `PUBLIC` continua permitido para objetos de sessão. ACLs padrão de `nexus_migrator`/`nexus_audit_writer` não podem conceder privilégios futuros a `PUBLIC` ou `nexus_app`. |
| Objetos privilegiados | As três funções `SECURITY DEFINER` esperadas têm owner e `search_path` fixos; `PUBLIC` e `nexus_app` não podem executá-las. |

Esses números são as expectativas codificadas no verificador, não uma alegação
de que uma instalação de produção foi executada nesta revisão.

---

## 7. Diagnóstico e recuperação

### `PREFLIGHT` ou `Unexpected output while reading migration ledger`

Pare e leia a mensagem completa. O preflight verifica o administrador, papéis,
memberships, ownership e a forma do ledger. `migrate.sh --check-only` verifica
nomes/checksums contra os arquivos locais. Não altere senhas nem reaplique
migrations até resolver a divergência indicada.

### Papéis existentes com atributos ou memberships inesperados

`00_prepare.sql` não executa `ALTER ROLE` corretivo e não remove memberships.
Corrija a configuração manualmente, com aprovação e entendimento do efeito, ou
use uma instalação/banco limpo conforme a política operacional. Execute o
preflight novamente antes de prosseguir.

### Migration falha

Leia a primeira mensagem PostgreSQL e o estado do ledger. A migration que
falhou e sua linha do ledger são revertidas juntas; versões anteriores que já
foram confirmadas permanecem. Após corrigir a causa, use o mesmo instalador: ele
validará o prefixo aplicado e só pulará linhas com nome e checksum idênticos.
Se o estado vier de uma versão antiga do runner e estiver parcial/ambíguo,
interrompa e faça recuperação manual com backup; não tente adotar um ledger
parcial.

### Fase 3 (GRANTs) falha após as migrations

As migrations e o ledger já estão confirmados. Corrija a causa; depois, uma nova
execução validará e pulará migrations já aplicadas, reaplicará os GRANTs
conhecidos e fará a verificação final. O script não executa REVOKE para limpar
privilégios adicionais.

### Verificação final falha

Não conecte a aplicação a esse banco até resolver o invariante. A verificação
não corrige ownership/ACL automaticamente. Preserve logs sem credenciais e
consulte o preflight/ledger e o runbook antes de qualquer ajuste manual.

---

## 8. Depois da instalação

O sucesso do instalador cobre somente o banco. A variável de conexão da aplicação,
qualquer mudança em Railway/Vercel e qualquer deploy são procedimentos separados,
fora do escopo deste script. Não marque a aplicação como pronta apenas pela
mensagem de conexão: use os testes de readiness e de fluxo da aplicação após a
configuração independente do consumidor.
