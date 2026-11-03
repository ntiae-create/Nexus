# Persistência do NEXUS

Este pacote contém o esquema SQL oficial do PostgreSQL, contratos TypeScript para acesso futuro e testes estáticos das migrações. Ele não abre conexões e não executa SQL por conta própria.

## Modelo de proprietário único

O NEXUS é SINGLE-USER: uma única identidade proprietária, sem cadastro público ou criação de outras contas. `owner_identity` é uma tabela singleton sem email ou credenciais. As tabelas de dados conservam `owner_id` como âncora de integridade à identidade e para políticas RLS, não como particionamento multiusuário. Chaves compostas que serviam exclusivamente para isolamento de tenants foram removidas; chaves compostas que asseguram a relação semântica entre conversa/mensagem/execução/etapa/provedor/modelo permanecem.

Nos contratos já existentes de `@nexus/shared`, o nome `userId` continua sendo o UUID do proprietário para preservar o formato compartilhado. Ele não permite selecionar outra conta; os contratos deste pacote expõem esse valor como `ownerId` e a coluna SQL usa `owner_id`.

A presença de `owner_identity` e de contexto RLS não implementa autenticação. O backend deve autenticar o proprietário, validar e autorizar cada operação. Aplicativos não recebem credenciais PostgreSQL e não acessam o banco diretamente. Não existe fluxo de cadastro público. Chaves e credenciais de provedores ficam exclusivamente no servidor, fora deste esquema.

## Migrações

As migrações SQL sequenciais ficam em `migrations/`. A estrutura ainda não aplicada pode ser ajustada diretamente em `00001_initial_schema.sql`; depois de aplicada, a migração é imutável e mudanças futuras devem ser novas migrações. Mudanças incompatíveis devem seguir expansão e contração. Não há arquivos de rollback: alterações compensatórias devem avançar por nova migração e precisam de planejamento específico.

**Recomendação para a futura ferramenta:** `postgres-migrations`. O projeto declara suporte a Node.js 10.17 ou superior, lê arquivos `.sql` sequenciais e verifica hashes de migrações aplicadas; esses requisitos são compatíveis com Node.js 24 e com dependência/scripts em um npm workspace. A biblioteca não foi instalada nem incorporada ao pacote nesta etapa. [Documentação do projeto](https://github.com/ThomWright/postgres-migrations).

A ferramenta usa advisory locks e documenta limitações com PgBouncer em transaction pooling ou statement pooling. Quando aprovada e adotada, executar migrações como tarefa operacional isolada com conexão PostgreSQL direta ou pooling de sessão, sem reutilizar o pool transacional da aplicação. Não rodar automaticamente no boot do backend.

### Aplicação futura

1. Aprovar e adicionar a ferramenta e seu driver PostgreSQL como dependências do workspace `@nexus/database`.
2. Fornecer conexão por secret manager no ambiente de deploy; não incluir DSN, usuário ou senha no repositório nem nos argumentos registrados em logs.
3. Aplicar `migrations/` por uma tarefa de deploy controlada, usando conexão dedicada e revisando mudanças de alto impacto.
4. Verificar a tabela de controle e os hashes registrados. Nunca editar uma migração já aplicada.
5. Antes de qualquer aplicação remota, verificar se há dados a preservar e definir backup/recuperação. Não há evidência de que esta migração tenha sido aplicada ou de dados de produção existentes.

## RLS e modelo de confiança

As políticas usam contexto PostgreSQL local à transação: `nexus.owner_id`, `nexus.actor_type` (`owner` ou `assistant`) e `nexus.assistant_id` quando o ator for um assistente. A camada de acesso deve abrir uma transação e defini-las com parâmetros, por exemplo `SELECT set_config('nexus.owner_id', $1, true)`. O terceiro argumento `true` torna o valor local à transação; nunca configurar variáveis em escopo de sessão num pool compartilhado. Sem contexto, o acesso às tabelas pessoais falha fechado. A identidade no banco é singleton e não há tenants ou isolamento entre contas.

RLS é defesa em profundidade, não substitui autenticação, autorização ou validação no backend. O backend deve executar com role sem `SUPERUSER`, `BYPASSRLS` ou propriedade das tabelas. O contexto PostgreSQL é uma afirmação do backend confiável: a role que pode executar SQL pode definir as variáveis de contexto e atuar com o contexto do proprietário. Portanto, esta configuração **não protege contra SQL arbitrário usando a própria credencial confiável do backend**. Proteja a credencial, restrinja rede e privilégios, e nunca permita acesso direto do APK ou navegador ao banco. `FORCE ROW LEVEL SECURITY` não se aplica a superusuários ou roles `BYPASSRLS`.

O ator `assistant` só pode ler sua memória individual e itens compartilhados com permissão ativa concedida pelo proprietário. Conceder ou revogar atualiza `memory_permissions` em transação; gatilhos registram a alteração em `memory_permission_audit`. A auditoria conserva IDs como snapshots mesmo após exclusões. Ausência de concessão não dá acesso.

Preferências manuais são aceitas apenas quando provedor e modelo estão disponíveis e existe autorização explícita do proprietário. Custos `paid` e `unknown` exigem autorização explícita de uso pago. A preferência nunca representa essa autorização por si só; o backend deve verificar novamente autorização, cota e custo ao iniciar cada execução, inclusive se a autorização tiver sido revogada depois de gravada a preferência.

## Limites desta base inicial

- O catálogo de provedores está vazio; credenciais pertencem ao secret manager do backend e não têm colunas nesta base.
- Dados JSON de mensagens, eventos, resultados e metadados rejeitam recursivamente chaves com nomes de credenciais e alguns formatos comuns de segredo; a detecção não cobre todas as credenciais possíveis.
- Tombstones são criados para exclusões de conversas, mensagens e memórias. A retenção dos tombstones e políticas de retenção, exportação, backups e exclusão definitiva continuam pendentes antes da implementação dos fluxos de exclusão/sincronização.
- Conteúdo de conversa é dado pessoal e não possui mecanismo universal de detecção de segredos embutidos em texto. A política de filtragem/redação antes da persistência e a proteção em repouso precisam ser definidas antes de colocar esse fluxo em produção; não registrar conteúdo integral em logs.
- As interfaces TypeScript são contratos para implementação futura. Não existe driver, pool, repositório concreto, endpoint, autenticação ou sincronização neste pacote.
- Os testes estáticos inspecionam arquivos e invariantes. A migração SINGLE-USER precisa ser executada em PostgreSQL de teste antes de aplicação remota; não declare validação real do PostgreSQL com base nos testes estáticos.
