# NEXUS.apk

Monorepo do assistente pessoal NEXUS, destinado a um único proprietário. O acesso será privado pelo APK Android e, futuramente, pelo navegador. Não haverá cadastro público nem contas de equipe. As decisões oficiais e os limites de segurança estão em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Requisitos

- Node.js 24
- npm 11 ou compatível com npm workspaces

## Instalação e execução

Na raiz do repositório:

```sh
npm install
npm run dev
```

O comando `dev` inicia o servidor Fastify e o aplicativo Vite para desenvolvimento. A arquitetura prevê que clientes conversem somente com o backend autenticado; não conectam diretamente ao PostgreSQL. O fluxo privado de autenticação está documentado em [`docs/MOBILE_AUTHENTICATION.md`](docs/MOBILE_AUTHENTICATION.md) e o chat móvel integrado ao NEXUS CORE em [`docs/MOBILE_CHAT.md`](docs/MOBILE_CHAT.md).

## Verificações

```sh
npm test
npm run build
```

## Estrutura

- `apps/mobile`: cliente Android baseado em React, Vite, TypeScript e Capacitor.
- `apps/server`: serviço Node.js/Fastify.
- `packages/shared`: contratos e tipos compartilhados com Zod.
- `packages/assistant-profiles`: perfis dos assistentes YUI, ALICE e SCHWI.
- `packages/database`: migração SQL inicial PostgreSQL, contratos de acesso futuro e testes.
- `packages/tools`: catálogo declarativo de ferramentas e políticas.

PostgreSQL será a fonte oficial dos dados; SQLite no dispositivo será cache e armazenará configurações locais. Autenticação, persistência funcional, sincronização e integração com provedores ainda não estão implementadas. As credenciais de provedores devem permanecer no servidor.
