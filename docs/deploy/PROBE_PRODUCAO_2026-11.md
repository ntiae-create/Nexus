# Resultado do probe contra https://nexus-server-five.vercel.app
# Executado pelo runner do GitHub Actions (o sandbox do agente nao abre TLS para vercel.app).
# Build que respondeu: commit d4648d2 (deploy de producao dpl_3SvUKYmjnEjpPkGy5RxF8onpkT1R).

GET  /v1/health           HTTP 200  {"status":"ok"}
GET  /v1/ready            HTTP 200  {"status":"ready"}
GET  /v1/assistants       HTTP 401  {"error":{"code":"UNAUTHORIZED",...}}      <- auth LIGADA
POST /v1/auth/login       HTTP 500  {"code":"42P01","message":"relation \"nexus.auth_login_state\" does not exist"}
GET  /v1/deploy-probe     HTTP 200  {"probe":"alive","commit":"d4648d2","authConfigured":true}

## Leitura

* `/v1/health`  -> a funcao subiu.
* `/v1/ready`   -> `checkConnectivity()` faz `SELECT 1`; passa contra QUALQUER
  banco existente. Prova que ha um PostgreSQL alcancavel, nao que o schema esta la.
* `/v1/assistants` -> 401 e nao mais `AUTH_NOT_CONFIGURED`: `NEXUS_SESSION_SECRET`
  e `NEXUS_OWNER_PASSWORD` chegaram ao runtime.
* `POST /v1/auth/login` -> **500 / 42P01**. O store de login escreve em
  `nexus.auth_login_state` a cada tentativa; a relacao nao existe.
  **O schema `nexus` nao foi aplicado no banco do Railway.**

## Consequencia

Isso NAO e falha de deploy: o codigo esta publicado e correto. E ausencia de
migracao no banco. Enquanto as migrations 00001..00008 nao forem aplicadas,
toda rota de dados responde 500, e `/v1/ready` continua verde — por isso ele
nao basta como criterio.

## Como fechar

`packages/database/scripts/migrate.sh` (neste repositorio) aplica as 8
migrations, com o preludio de papeis que a 00007 documenta. Ver o relatorio
para a sequencia exata e o que precisa existir antes.

## Nota de proveniência temporal

O conteúdo acima é preservado como registro versionado do resultado reportado.
Nesta revisão, a data efetiva das requisições e a correspondência entre o
transcript, o deployment identificado e os metadados do Git não foram
verificadas independentemente. Portanto, este arquivo não constitui, por si só,
prova independente de um incidente nem confirmação do estado atual de produção.
Nenhum endpoint de produção foi consultado nesta revisão.
