# Arquitetura do NEXUS.apk

> **Status:** especificação arquitetural inicial. Este documento separa decisões aprovadas, recomendações técnicas e decisões pendentes. Componentes e contratos descritos são especificações, não afirmações de que já estejam implementados.

## 1. Visão geral

O NEXUS.apk é um aplicativo Android cuja interface usa **React, Vite e TypeScript** e cuja integração com a plataforma Android é feita por **Capacitor**. O aplicativo se comunica exclusivamente com o backend hospedado, implementado com **Node.js e Fastify**, por uma API autenticada em HTTPS. O aplicativo nunca conecta diretamente ao PostgreSQL nem a provedores de modelos.

O **NEXUS CORE** é o coordenador central de **YUI** (assistente pessoal), **ALICE** (pesquisa e análise) e **SCHWI** (lógica, planejamento e resolução de problemas). O histórico oficial fica no **PostgreSQL**. O aplicativo usa **SQLite** como cache e armazenamento dos dados sincronizados, incluindo histórico disponível para consulta offline. A operação offline não promete respostas de IA.

A primeira versão usa serviços online autorizados pelo backend e inclui pesquisa externa para ALICE. A arquitetura deve permitir a integração futura de modelos locais por um contrato comum, sem definir nesta versão onde serão executados.

### 1.1 Diagrama lógico

```text
┌──────────────────────────────── Aplicativo Android ───────────────────────────────┐
│ React + Vite + TypeScript                                                         │
│ Interface ─ serviços ─ sincronização/cache ─ SQLite                               │
│                    │                                                              │
│                 Capacitor                                                         │
└────────────────────┼─────────────────────────────────────────────────────────────┘
                     │ HTTPS autenticado
                     ▼
┌──────────────────────────── Backend hospedado ───────────────────────────────────┐
│ Node.js + Fastify                                                                 │
│ API ─ autenticação/autorização ─ NEXUS CORE ─ histórico/memória (PostgreSQL)      │
│                                      │                                            │
│                                YUI · ALICE · SCHWI                                 │
│                                      │                                            │
│              Gerenciador de provedores/modelos e ferramentas de pesquisa          │
└───────────────────────┬──────────────────────────────┬───────────────────────────┘
                        ▼                              ▼
              Provedores de modelos         Ferramentas/fontes de pesquisa

              Futuro: adaptadores de modelos locais (local de execução pendente)
```

## 2. Legenda de decisão

- **Decisão aprovada:** requisito oficial adotado para esta arquitetura. Não é sugestão e deve orientar a implementação correspondente.
- **Recomendação técnica:** orientação arquitetural que deve guiar o desenho, sem fixar fornecedor ou mecanismo ainda não aprovado.
- **Pendente:** decisão que requer definição antes da implementação da funcionalidade correspondente.
- **Versão futura:** melhoria preparada pela arquitetura, mas que não constitui requisito da V1.

## 3. Componentes e responsabilidades

### 3.1 Aplicativo Android

- **React:** interface de conversas, assistentes, histórico, pesquisa, configurações e gestão de consentimentos.
- **Vite:** build e desenvolvimento da aplicação web que será empacotada no aplicativo Android.
- **TypeScript:** tipagem da interface, serviços, repositórios e contratos usados pelo cliente.
- **Camada de aplicação/serviços:** coordena as ações da UI e chama a API. Não contém chaves de provedores nem regras que substituam autorização do servidor.
- **SQLite:** cache e armazenamento local de dados sincronizados, para consulta de histórico e configurações locais.
- **Capacitor:** empacotamento Android e acesso controlado a recursos da plataforma quando necessários. A interface permanece separada das APIs específicas do Android.
- **Zod:** validação no cliente para feedback e integridade local; não substitui validação no servidor.

### 3.2 Backend hospedado

- **Node.js + Fastify:** API, autenticação, autorização, validação, limites operacionais e respostas de erro consistentes.
- **NEXUS CORE:** recebe solicitações, seleciona e coordena assistentes, aplica políticas de contexto, memória, ferramentas e provedores, e mantém o registro da execução.
- **YUI:** assistente pessoal; usa somente contexto e memória necessários e autorizados.
- **ALICE:** pesquisa e análise; pode acionar a camada de ferramentas de pesquisa externa da V1.
- **SCHWI:** lógica, planejamento e resolução de problemas.
- **Gerenciador de provedores e modelos:** catálogo permitido, capacidades, escolha manual/automática e aplicação das regras de custo, autorização e cotas.
- **Camada de ferramentas de pesquisa:** interfaces independentes dos modelos para pesquisa externa, coleta de referências e normalização de resultados.
- **Serviços de histórico e memória:** persistem os dados do proprietário no PostgreSQL sob controle de acesso do backend.
- **Adaptadores:** traduzem entre contratos internos e APIs de provedores de modelos ou ferramentas. Segredos de integração permanecem no backend.

### 3.3 Limites entre componentes

O aplicativo só conversa com o backend autenticado. O CORE coordena os assistentes por contratos internos; os assistentes não acessam diretamente os bancos, provedores ou memórias uns dos outros. O CORE fornece a cada etapa apenas o contexto necessário e autorizado. Adaptadores isolam formatos e particularidades de fornecedores.

## 4. Estrutura de pastas proposta

Estrutura conceitual. **Pendente:** decidir monorepo ou repositórios separados, nomes finais e ferramenta de build.

```text
NEXUS/
├── apps/
│   └── android/                  # React, Vite, TypeScript e Capacitor
│       └── src/
│           ├── app/               # inicialização, navegação e composição
│           ├── features/          # conversas, assistentes, histórico, pesquisa
│           ├── components/        # componentes de interface reutilizáveis
│           ├── services/          # cliente HTTP e casos de uso do cliente
│           ├── repositories/      # SQLite e dados sincronizados
│           └── validation/        # schemas Zod do cliente
├── backend/
│   └── src/
│       ├── app/                   # montagem e ciclo de vida do Fastify
│       ├── routes/                # endpoints HTTP
│       ├── auth/                  # identidade, sessão e autorização
│       ├── core/                  # coordenação NEXUS CORE
│       ├── assistants/            # YUI, ALICE e SCHWI
│       ├── providers/             # catálogo, seleção e adaptadores
│       ├── research/              # ferramentas de pesquisa externa
│       ├── memory/                # memória, permissões e recuperação
│       ├── history/               # mensagens, eventos e execuções
│       ├── db/                    # PostgreSQL, migrações e repositórios
│       └── schemas/               # schemas Zod autoritativos do servidor
├── packages/
│   └── contracts/                # contratos internos compartilháveis (se monorepo)
└── docs/
```

**Recomendação técnica:** contratos compartilhados podem reduzir divergências entre cliente e servidor; validação e autorização do servidor continuam sendo autoritativas.

## 5. NEXUS CORE e orquestração

### 5.1 Regras operacionais

1. O CORE recebe a solicitação autenticada e determina o assistente mais adequado: YUI para tarefas pessoais, ALICE para pesquisa/análise e SCHWI para lógica, planejamento e resolução de problemas.
2. Quando a tarefa exigir, pode encaminhar sub tarefas a mais de um assistente e reunir seus resultados.
3. Cada encaminhamento registra a etapa, o assistente, o objetivo, a referência ao contexto fornecido e o resultado ou falha. O CORE mantém limites configurados para número de etapas, repasses e tamanho do contexto.
4. O CORE acompanha os assistentes já acionados e os encaminhamentos realizados para impedir ciclos. Um limite atingido encerra ou degrada a execução com estado explícito, sem repetição indefinida.
5. Cada assistente recebe somente informações necessárias à sua tarefa, sujeitas às permissões de memória e aos controles de dados externos.
6. Se resultados divergirem, o CORE identifica a divergência e apresenta a incerteza ou as posições relevantes com transparência; não deve fabricar consenso.
7. Uma falha de assistente é registrada como falha parcial. O CORE pode continuar com resultados válidos e informar limitações; falha parcial não invalida automaticamente a conversa inteira.
8. O CORE preserva o histórico da solicitação, encaminhamentos, ferramentas, falhas, resultados e resposta final como registros relacionados, mas separados.

**Recomendação técnica:** separar o estado da orquestração do texto final da conversa e definir estados terminais para sucesso, sucesso parcial, cancelamento e falha. **Pendente:** valores numéricos para limites, política de recuperação/repetição e estratégia de resolução quando houver conflito.

### 5.2 Fluxo geral

1. O cliente envia mensagem, conversa, assistente preferido e identificador de requisição pela API autenticada.
2. O backend autentica o proprietário, valida o contrato com Zod, verifica a propriedade da conversa e aplica limites de abuso.
3. O CORE carrega do PostgreSQL o histórico necessário e recupera apenas memória autorizada e relevante.
4. A seleção de modelo e, quando aplicável, ferramentas de pesquisa é verificada contra catálogo, permissões, custo e cotas.
5. Adaptadores invocam os serviços autorizados. Resultados e falhas são normalizados e registrados.
6. O CORE pode executar novas etapas dentro dos limites operacionais e produz resposta completa ou parcial.
7. O backend grava mensagens, eventos e execução no PostgreSQL e devolve resultado ao cliente. A sincronização atualiza a cópia local SQLite.

## 6. Memória e permissões

### 6.1 Tipos de memória

- **Decisão aprovada — memória individual:** cada assistente possui memória individual separada (YUI, ALICE ou SCHWI). Cada assistente só pode recuperar sua própria memória individual.
- **Decisão aprovada — memória compartilhada:** significa compartilhamento entre os assistentes do único proprietário. Cada item compartilhado exige permissões explícitas por assistente; o proprietário pode conceder e revogar cada permissão individualmente.

Nenhum assistente tem acesso irrestrito à memória dos outros. A participação de outro assistente passa pelo CORE e está sujeita às permissões do item e ao contexto mínimo necessário. O produto é exclusivamente pessoal: não há workspaces, equipes ou compartilhamento entre pessoas.

### 6.2 Metadados e acesso

Cada item de memória registra origem, data de criação, versão do formato e tipo (individual ou compartilhado). O banco ancora os dados à identidade singleton do proprietário. A estrutura `memory_permissions` registra permissões explícitas por item e assistente, incluindo concessão, revogação, ator e timestamps, de modo a permitir auditoria. A revogação bloqueia novos acessos, mas não recolhe informações já incluídas em contexto e transmitidas a provedores externos.

O CORE verifica a permissão no momento de cada recuperação e entrega somente os dados necessários à tarefa. Permissões podem ser revogadas pelo proprietário. Revogar impede acessos futuros por essa autorização, mas **não recolhe informações que já tenham sido incluídas em contexto e enviadas anteriormente a um provedor externo**.

**Recomendação técnica:** não transformar automaticamente todas as mensagens em memória; tornar criação, revisão e compartilhamento ações controláveis e auditáveis pelo proprietário.

**Decisões aprovadas:** o proprietário poderá excluir memórias; edição de mensagens não fará parte da V1. Retenção, exportação e exclusão definitiva devem ter políticas documentadas antes da implementação dessas funcionalidades. Exclusões devem considerar PostgreSQL, SQLite, cache, backups e dispositivos sincronizados; usar tombstones para propagá-las a dispositivos ainda não sincronizados. Não se promete exclusão imediata de cópias em backups sem política técnica definida.

**Pendências antes da implementação de memória:** critérios de criação/extração, edição de memórias, retenção, exportação, exclusão definitiva, auditoria detalhada e granularidade adicional das permissões.

## 7. Histórico, formato interno e provedores

### 7.1 Formato independente

O histórico usa um formato interno do produto, independente de APIs de provedores. Os dados persistidos são separados em:

- **Mensagens:** conteúdo de usuário, assistente e CORE, com papel/autor, ordem, horário e versão do formato.
- **Eventos de ferramentas:** chamada, parâmetros permitidos, estado, referências e resultado normalizado; não confundir com uma mensagem comum. Persistir origem, tipo, data, versão do formato e vínculo com a execução; evitar conteúdo bruto externo desnecessário e nunca persistir segredos, credenciais ou chaves de API.
- **Execuções do CORE:** solicitação, estado, etapas, encaminhamentos, identificador de requisição e vínculos para entradas e resultados.
- **Resultados:** respostas de cada etapa e resposta final, inclusive falhas e resultados parciais.
- **Metadados de execução:** provedor e modelo utilizados, capacidades relevantes e outros metadados operacionais disponíveis, sem torná-los necessários para ler a conversa.

Mensagens, eventos e contratos internos devem ser versionados para permitir evolução e migração. Eventos e resultados devem conservar dados normalizados, referências, estados e metadados suficientes para reconstruir o histórico, auditar e compreender as respostas, evitando armazenar conteúdo bruto desnecessário de páginas, documentos e respostas externas. **Pendente:** política de compatibilidade e estratégia de migração entre versões.

**Decisão aprovada:** o proprietário poderá excluir conversas; edição de mensagens não fará parte da V1. Aplicam-se as políticas de retenção, exportação, exclusão e tombstones definidas na seção 8.3.

### 7.2 Troca de provedor

A troca de provedor não remove nem reescreve mensagens históricas. O contexto para uma nova solicitação é reconstruído do formato interno e das memórias autorizadas, não de um histórico armazenado exclusivamente no provedor. O provedor e modelo de cada execução são informados ao proprietário e registrados como metadados.

A compatibilidade de recursos pode variar: ferramentas, formatos estruturados, anexos ou capacidades específicas de um modelo podem não ser reproduzíveis em outro. A interface e o CORE devem indicar essa limitação quando afetar a solicitação, sem prometer equivalência de resultados.

## 8. Bancos de dados e sincronização

### 8.1 PostgreSQL remoto

**Decisões aprovadas — modelo SINGLE-USER:** o NEXUS tem uma única identidade proprietária, sem cadastro público nem criação de outras contas. PostgreSQL é a fonte oficial das conversas, mensagens, eventos, execuções, memórias, permissões, catálogos e preferências. O banco representa o proprietário em `owner_identity`, uma tabela singleton; `owner_id` nas tabelas pessoais é uma âncora de integridade para essa identidade, não um seletor de tenant. Não há isolamento ou colaboração entre usuários.

O backend autentica o proprietário, valida cada solicitação e autoriza operações e recursos. O APK e o futuro navegador não conectam diretamente ao PostgreSQL. Credenciais de banco e chaves de provedores ficam exclusivamente no servidor/secret manager. O mecanismo privado de autenticação, sessões, recuperação e acesso do navegador permanece pendente; cadastro público é proibido.

RLS é uma camada de defesa adicional e falha fechada sem contexto válido. O contexto transacional identifica a identidade singleton; o contexto de ator também restringe operações a proprietário ou assistente, e leituras por assistente continuam sujeitas às permissões de memória. Usar contexto local por transação, por exemplo `set_config(..., true)`, para evitar vazamento por pooling. A role de aplicação não deve ser `SUPERUSER`, `BYPASSRLS` ou proprietária das tabelas.

**Limite de confiança:** o contexto RLS é uma afirmação do backend confiável, não uma prova independente de autenticação. Uma role de backend que tenha credenciais PostgreSQL e permissão para executar SQL pode definir variáveis de contexto e acessar dados como o proprietário. RLS não protege contra SQL arbitrário executado com a credencial confiável do backend. A proteção depende também de autenticação/autorização corretas no backend, privilégio mínimo, controle de acesso à rede e proteção das credenciais. Não existe papel anônimo com acesso aos dados.

#### 8.1.1 Modelo relacional conceitual

O modelo contém `owner_identity` (singleton), `assistants`, `assistant_config_versions`, `conversations`, `conversation_assistants`, `messages`, `core_runs`, `run_steps`, `tool_events`, `run_results`, `assistant_memories`, `memory_permissions`, `memory_permission_audit`, `providers`, `models`, `provider_authorizations`, `global_provider_preferences`, `assistant_provider_preferences`, `conversation_provider_preferences`, `sync_cursors` e `tombstones`. Não existe tabela de cadastro ou estrutura de compartilhamento entre pessoas.

Usar UUIDs e timestamps com fuso horário. `owner_id` é uma chave estrangeira simples para a linha singleton e uma âncora para RLS; chaves compostas usadas exclusivamente para isolar tenants foram removidas. Permanecem chaves compostas quando asseguram relações semânticas, como execução e conversa, etapa e execução, ou provedor e modelo. Conversas, mensagens e eventos mantêm ordem, referências e versões de formato.

Nos contratos compartilhados existentes, `userId` identifica essa única identidade proprietária por compatibilidade do formato. Não é seleção de conta, identidade alternativa nem fronteira de tenant; no banco, o campo correspondente é `owner_id`.

As memórias individuais de YUI, ALICE e SCHWI permanecem separadas. Memórias compartilhadas entre assistentes exigem concessão explícita por item; concessões e revogações são auditadas. Preferências de provedor/modelo mantêm escopos global, por assistente e por conversa, nessa precedência. Autorizações de provedor e de uso pago são dados separados das preferências.

`assistants` é um catálogo extensível. YUI, ALICE e SCHWI têm configurações inicialmente estáticas no código e versões identificáveis; cada execução registra a versão usada. Gerenciamento dinâmico futuro não será implementado na V1.

#### 8.1.2 Migrações

**Decisões aprovadas:** centralizar migrações e convenções de persistência em `packages/database`; utilizar migrações SQL versionadas; escolher uma ferramenta compatível com PostgreSQL antes de implementar migrações. Migrações aplicadas não são modificadas retroativamente. Preferir estratégias compatíveis de expansão e contração. Migrações destrutivas e backfills exigem planejamento específico. A ferramenta não está escolhida e não será instalada nesta etapa de arquitetura.

### 8.2 SQLite local

**Decisões aprovadas:** SQLite funciona como cache local de dados sincronizados e armazenamento de configurações exclusivas do dispositivo. Deve permitir consultar offline o histórico sincronizado e configurações locais. O aplicativo nunca acessa PostgreSQL diretamente; toda operação remota passa pelo backend autenticado. Não se promete resposta de IA sem conexão. Preferências pertencentes à conta devem ser distinguidas das configurações locais do dispositivo.

### 8.3 Sincronização, conflitos e proteção

**Decisões aprovadas:** utilizar cursor opaco de sincronização por dispositivo da única conta e suportar sincronização incremental. PostgreSQL permanece oficial; alterações oficiais são confirmadas pelo backend. O cliente mantém cópias autorizadas pelo servidor. O cache contém somente dados do proprietário e deve ser protegido e limpo quando o proprietário encerrar a sessão ou remover os dados locais. Exclusões são propagadas por tombstones para dispositivos ainda não sincronizados.

Escritas locais de configuração exclusiva do dispositivo não se tornam alterações de conta. Alterações de dados oficiais só são consideradas confirmadas após aceitação do backend. Histórico sincronizado é consultável offline; envio de mensagens que requerem IA depende de conectividade.

**Recomendação técnica:** vincular dados locais à sessão autenticada do proprietário e refletir claramente estados pendentes/atualizados. Proteger o armazenamento local e credenciais de sessão; usar criptografia local quando tecnicamente suportada pela plataforma e pela solução SQLite escolhida.

**Pendências antes da implementação completa da sincronização:** tratamento e resolução de conflitos, retenção dos tombstones, política de retenção de cache de dados excluídos, invalidação/limpeza local ao encerrar sessão ou remover os dados do dispositivo e mecanismo concreto de proteção/criptografia local. Retenção, exportação e exclusão definitiva devem ser documentadas antes de implementar essas funcionalidades. Exclusões devem considerar PostgreSQL, SQLite, cache, backups e dispositivos sincronizados; não prometer exclusão imediata de cópias em backups sem política técnica definida.

## 9. Provedores e modelos

- Adaptadores independentes isolam APIs, formatos, erros e capacidades específicas de cada provedor.
- O catálogo do backend contém apenas provedores e modelos autorizados para uso, com capacidades e informações operacionais necessárias. Segredos nunca fazem parte do catálogo enviado ao cliente.
- **Decisão aprovada — preferências:** manter preferência global do proprietário, preferência por assistente e escolha opcional por conversa. Precedência: escolha explícita da conversa, depois preferência do assistente e, na ausência desta, preferência global. A escolha da conversa vale somente naquela conversa.
- **Seleção manual:** proprietário escolhe uma opção disponível e compatível.
- **Seleção automática:** backend escolhe segundo critérios definidos e políticas obrigatórias de autorização, custo, capacidade, disponibilidade e cotas. Deve respeitar provedores autorizados, cotas, gratuidade confirmada e permissões.
- Serviços pagos ficam desativados por padrão. Nenhum pode ser utilizado sem autorização específica e válida do proprietário.
- Nenhuma preferência, inclusive preferência de conversa, autoriza silenciosamente serviço pago.
- Se preço, gratuidade ou cota não puderem ser confirmados, o serviço não é chamado. O sistema não tenta contornar cotas, limites técnicos ou termos do provedor.
- O usuário é informado sobre qual provedor e modelo foram utilizados. Uma alternativa automática só pode ser usada se também estiver autorizada e passar pelas mesmas verificações.
- Histórico e contexto interno permanecem independentes do provedor; trocar de fornecedor não apaga o histórico, embora recursos e resultados possam variar.

### 9.1 Preparação para modelos locais

**Aprovado:** preparar um contrato comum para adaptadores de modelos locais futuros. Esta versão não define se a execução será no Android, em outro dispositivo ou em servidor, e não inclui execução local como requisito da V1. **Pendentes:** localização, runtime, hardware, distribuição, disponibilidade e implicações de privacidade.

## 10. ALICE e pesquisa externa (V1)

Pesquisa externa faz parte da primeira versão, embora possa ser implementada depois do chat básico. A pesquisa é acessada por uma camada de ferramentas separada dos modelos, de modo que a ferramenta possa ser substituída sem acoplar a lógica da ALICE a um fornecedor específico.

- Cada busca registra fontes consultadas e referências associadas aos resultados usados.
- A resposta apresenta referências ao usuário de forma vinculada às afirmações apoiadas, conforme as capacidades da fonte.
- Páginas, documentos, resultados de busca, anexos e outros conteúdos externos são dados não confiáveis, não instruções de sistema.
- Instruções maliciosas encontradas em fontes não podem alterar políticas, revelar segredos, conceder permissões ou disparar ações fora da tarefa autorizada. O conteúdo deve ser isolado e tratado como material a analisar.
- A camada aplica limites de pesquisa e contexto e registra falhas, fontes inacessíveis e resultados parciais. Falha de pesquisa não deve ser apresentada como pesquisa bem-sucedida.
- Nenhum serviço de pesquisa pago ou fornecedor específico é aprovado por esta especificação. Aplicam-se as regras de autorização de custo, gratuidade, cotas e termos da seção de provedores.

**Pendentes:** ferramenta(s) elegível(is), método de busca/coleta, critérios de seleção de fontes, apresentação de citações, limites numéricos, tratamento de conteúdo e política de fallback.

## 11. API e confiabilidade

A API REST versionada sobre HTTPS é a proposta inicial. As rotas abaixo são ilustrativas, não contrato final.

| Método e rota | Finalidade |
| --- | --- |
| `GET /v1/health` | estado do serviço sem expor dados sensíveis |
| `GET /v1/assistants` | assistentes disponíveis |
| `GET /v1/providers` | modelos/provedores autorizados e capacidades públicas |
| `GET /v1/conversations` | conversas do proprietário autenticado |
| `POST /v1/conversations` | criar conversa |
| `GET /v1/conversations/:id/messages` | obter mensagens autorizadas |
| `POST /v1/conversations/:id/messages` | registrar solicitação e iniciar execução do CORE |
| `GET/PUT /v1/preferences/providers` | consultar/alterar preferência de seleção |
| Rotas de memória | consultar e gerir memória e permissões conforme autorização |

### 11.1 Confiabilidade das solicitações

- Cada requisição tem identificador rastreável que correlaciona resposta, eventos e execução, sem incluir segredos.
- Envio de mensagem usa chave/identificador de idempotência para que uma repetição da mesma operação não crie mensagens ou execuções duplicadas.
- Chamadas têm timeouts. O cliente pode solicitar cancelamento; o backend registra o estado e propaga cancelamento quando suportado. Cancelamento não garante que um serviço externo já iniciado interrompa processamento ou cobrança.
- Falhas parciais são representadas separadamente: uma ferramenta ou assistente pode falhar enquanto etapas independentes concluem. O resultado indica o que foi concluído e o que falhou.
- Mensagem recebida, execução do CORE, eventos de ferramentas e resultados são persistidos como registros relacionados e com estados próprios, evitando que a resposta final seja o único registro da operação.
- Streaming pode ser usado quando suportado pelo provedor e pelo fluxo; sua ausência não altera a semântica de persistência. A mensagem/execução deve manter estado até conclusão, falha ou cancelamento.

**Pendentes:** protocolo de streaming, nomes e ciclo de vida dos identificadores, duração de timeouts, janela de idempotência, semântica de cancelamento, paginação e envelope de erros.

## 12. Segurança e privacidade

### 12.1 Identidade e autorização

**Decisão aprovada — SINGLE-USER:** há uma única identidade pessoal proprietária. Não haverá cadastro público, criação de outras contas, equipes, workspaces ou compartilhamento entre pessoas. O NEXUS é acessível privadamente pelo APK Android e, futuramente, pelo navegador.

O método privado de autenticação do proprietário, sessão e recuperação ainda precisa ser escolhido. O backend autentica cada chamada e autoriza recursos; conhecer um identificador não concede acesso. Nem o aplicativo móvel nem o navegador recebem acesso direto ao banco. O RLS e seu limite de confiança estão descritos na seção 8.1.

O aplicativo nunca contém credenciais de provedor. Chaves de API ficam exclusivamente no servidor, em armazenamento de segredos apropriado ao ambiente, e não aparecem em respostas, APK, eventos ou logs.

### 12.2 Proteções

- Comunicação cliente/backend exclusivamente por HTTPS.
- Proteção das sessões e credenciais locais; detalhes do mecanismo dependem da decisão de autenticação e da plataforma.
- Criptografia dos dados locais quando tecnicamente suportada pela plataforma e solução selecionadas.
- Autorização no backend para conversas, histórico, memórias, permissões, preferências e execuções.
- Limites contra abuso e consumo excessivo; limites numéricos e política de bloqueio são pendentes.
- Logs e métricas sem conteúdo sensível desnecessário, credenciais, chaves ou contexto integral por padrão.
- Conteúdo de modelos, ferramentas, páginas, documentos, pesquisas e arquivos é não confiável. Não pode sobrepor instruções de segurança, autorizar custos ou conceder permissões.
- Validação Zod no cliente e no servidor. A validação do servidor é a autoridade e ocorre antes de processar dados.
- **Decisão aprovada:** o proprietário poderá excluir conversas e memórias. Retenção, exportação e exclusão definitiva devem possuir políticas documentadas antes da implementação dessas funcionalidades. Exclusões devem considerar PostgreSQL, SQLite, cache, backups e dispositivos sincronizados; tombstones propagam exclusões a dispositivos ainda não sincronizados. Não prometer exclusão imediata de cópias em backups sem política técnica definida.
- Minimizar dados enviados a provedores e enviar memória somente se necessária e autorizada. A revogação de memória não recolhe dados já transmitidos a provedores externos.

**Pendentes:** método privado de autenticação do proprietário, proteção/expiração/renovação de sessão, armazenamento local de credenciais, limites contra abuso, política de logs, retenção, exclusão, backup e requisitos de resposta a incidentes.

## 13. Validação e qualidade

**Zod** valida contratos no cliente para feedback e no servidor para validação autoritativa. **Vitest** é a ferramenta prevista para testes TypeScript. A estratégia e os ambientes são pendentes. Áreas recomendadas: autorização do proprietário e controles de memória, regras do CORE e prevenção de ciclos, limites de contexto, permissões e revogação de memória, idempotência, sincronização/conflitos, normalização de adaptadores, citações da ALICE e falhas parciais. Testes não devem consumir cotas reais ou chamar serviços pagos sem autorização específica.

## 14. Fases de desenvolvimento

1. **Fundação e contratos:** definir organização do repositório, contratos versionados, schemas, padrão de erros, identidade singleton do proprietário, autenticação privada, autorização e controles de acesso. Definir também o contrato e os limites de acesso à memória, antes de implementar assistentes. Preparar PostgreSQL como fonte oficial e plano de SQLite como cache sincronizado.
2. **Backend, persistência e sincronização básica:** API Fastify autenticada, modelo de dados inicial, migrações, histórico independente, identificadores de requisição/idempotência e sincronização de cache.
3. **Aplicativo e chat básico:** React/Vite/TypeScript, Capacitor, interface de conversa, consulta de histórico sincronizado offline e configurações locais. Respostas de IA dependem de conexão.
4. **CORE e assistentes:** YUI, ALICE e SCHWI, seleção de fluxo, limites de etapas/repasses/contexto, prevenção de ciclos, falhas parciais e registro de execução.
5. **Provedores de modelos:** adaptadores elegíveis, catálogo, seleção manual e automática, autorização específica para pagos, verificação de preço/cota e informação de provedor/modelo ao usuário.
6. **Pesquisa externa da ALICE (V1):** camada de ferramentas separada, registro de fontes, referências, limites e proteção contra conteúdo/instruções maliciosas. Pode ser implementada após o chat básico, mas integra o escopo da V1.
7. **Memória:** implementar compartimentos individuais e compartilhamento por item, autorização por assistente, revogação e ciclo de vida depois dos contratos e controles definidos na fundação.
8. **Melhorias reservadas para versões futuras:** gerenciamento dinâmico de configurações de assistentes, se aprovado em etapa própria. Manter contrato para adaptadores de modelos locais. Execução local e sua localização não fazem parte desta versão.

Ordem detalhada, critérios de aceite, cronograma e dimensionamento das fases são pendentes. Preparar modelos locais não significa implementar execução local agora.

## 15. Decisões técnicas pendentes

Esta lista registra questões não aprovadas; não se deve inferir fornecedores, preços, limites ou mecanismos específicos a partir do documento.

- Monorepo ou repositórios separados, ferramenta de build e organização final das pastas.
- Método privado de autenticação do proprietário, sessão, recuperação e armazenamento seguro de credenciais.
- Esquema PostgreSQL detalhado, índices, política de compatibilidade e versões exatas de mensagens, eventos, execuções e resultados.
- Ferramenta de migração PostgreSQL compatível, a escolher antes da implementação; nenhum produto foi aprovado.
- Resolução de conflitos de sincronização, retenção de tombstones, comportamento de edição offline e política de limpeza de cache local.
- Políticas de retenção, backup, exportação, exclusão definitiva e tratamento de dados sincronizados/cache, a documentar antes de implementar essas funcionalidades.
- Critérios de criação/revisão de memória, edição, retenção e detalhes adicionais de auditoria e permissões por item.
- Provedores/modelos e ferramentas de pesquisa elegíveis, sem aprovação antecipada de fornecedores pagos.
- Critérios e limites numéricos de seleção automática, etapas, repasses, contexto, pesquisa, cotas, timeouts e idempotência.
- Processo de autorização específica de serviços pagos e forma de apresentar custo/cota confirmados.
- Ferramenta e método de pesquisa da ALICE, critérios de fontes, formato das referências e política de falhas/fallback.
- Protocolo de streaming, paginação, anexos e cancelamento de operações externas.
- Gestão de segredos, hospedagem, implantação, observabilidade, recuperação de desastre e resposta a incidentes.
- Requisitos detalhados de criptografia local, logs, retenção e proteção de dados.
- Local de execução, runtime, hardware, distribuição e disponibilidade dos futuros modelos locais.
- Critérios de aceite e ambiente de testes automatizados com Vitest.

### 15.1 Melhorias reservadas para versões futuras

- Gerenciamento dinâmico de configurações de assistentes. Na V1, YUI, ALICE e SCHWI são configurados estaticamente no código e identificados por versão.
- Execução de modelos locais; localização e runtime continuam pendentes e não integram a V1.
