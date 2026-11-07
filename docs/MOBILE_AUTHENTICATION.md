# Autenticação no aplicativo móvel (Etapa 3C.1)

O aplicativo consome a API existente sem alterar contratos: `POST /v1/auth/login`, `GET /v1/auth/me` e `POST /v1/auth/logout`. A senha do proprietário é o único fator; não há e-mail, cadastro, múltiplas contas ou recuperação de senha nesta etapa.

## Camadas

| Módulo | Arquivo | Responsabilidade |
| --- | --- | --- |
| Endereço da API | `src/lib/config.ts` | Resolve `getApiBaseUrl()`, valida a URL e expõe o endereço para a tela de configuração. |
| Cliente HTTP | `src/services/api-client.ts` | Único ponto de `fetch`. Injeta `Authorization: Bearer`, aplica timeout, traduz falhas em `ApiError` e nunca registra corpo, senha ou token. |
| Serviço de autenticação | `src/services/auth-service.ts` | Valida as respostas com Zod e mapeia os contratos de login, `/me` e logout. |
| Armazenamento seguro | `src/lib/auth/secure-storage.ts` | Política de persistência do token por plataforma. |
| Sessão | `src/lib/auth/session-manager.ts` | Restore, login, logout, invalidação e regras de concorrência. |
| Estado de UI | `src/state/auth-context.tsx` | Expõe o snapshot da sessão ao React. |
| Montagem | `src/lib/auth/bootstrap.ts` | Constrói o grafo de dependências antes do primeiro render. |
| Telas | `src/screens/` | Login, sessão ativa e configuração do endereço da API. |

## Armazenamento do token por plataforma

- **Android (Capacitor):** plugin local `SecureSession`, implementado em `android/app/src/main/java/dev/nexus/mobile/SecureSessionPlugin.java`, sobre `EncryptedSharedPreferences` com `MasterKey` do Android Keystore (`androidx.security:security-crypto`). Não existe fallback em `SharedPreferences` comum: se o Keystore falhar, a operação lança erro e a sessão é tratada como "não salva".
- **Navegador:** o token fica apenas em memória, no escopo do módulo. `localStorage` não é usado porque o backend web do `@capacitor/preferences` é exatamente `window.localStorage`, legível por qualquer script da origem. Consequência aceita: recarregar a página exige novo login. O alvo do produto é o APK; o build de navegador serve para desenvolvimento e pré-visualização.
- **Backup do Android:** `backup_rules.xml` e `data_extraction_rules.xml` excluem o `SharedPreferences` da sessão de backup em nuvem e de transferência entre dispositivos, e o manifesto declara ambos os atributos.

A senha nunca é persistida em nenhum backend, e o token nunca é renderizado, registrado ou incluído em mensagens de erro.

## Fluxos

**Restauração.** `restore()` lê o token e valida com `GET /v1/auth/me` antes de entrar no aplicativo. `401` significa sessão inválida: o token é apagado e a tela de login informa a expiração/revogação. Qualquer outra falha (rede, `5xx`) mantém o token no dispositivo, mas não entra no aplicativo e mostra "não foi possível validar"; uma próxima abertura tenta novamente.

**Login.** Uma única requisição por vez: chamadas concorrentes reaproveitam a mesma promessa, de modo que toques repetidos não geram duas tentativas nem consomem o limite de bloqueio. A tela permanece bloqueada durante a requisição e traduz `401`, `429`, `503` e falha de conexão em mensagens compreensíveis.

**Logout.** O servidor é chamado primeiro, para revogar o token. O estado local é limpo em seguida, inclusive quando o servidor está inacessível. Nesse caso o aplicativo informa que a revogação não foi confirmada, em vez de manter o usuário conectado.

## Endereço da API

A precedência é: preferência `nexus.apiBaseUrl` (definida em "Configurar endereço da API", dentro do aplicativo) → chave legada `nexus.apiBaseUrl` do `localStorage` (gravada por versões anteriores) → `VITE_NEXUS_API_URL` → padrão de desenvolvimento apenas no navegador. No Android, o valor legado é migrado para `Preferences` na inicialização, sem nunca sobrescrever uma preferência mais nova; no navegador, ele é lido diretamente, e só contém endereço — nunca credencial. Em Android não há padrão: sem endereço configurado, o aplicativo pede o endereço em vez de assumir `localhost`, que no dispositivo aponta para o próprio aparelho. A URL precisa ser absoluta `http`/`https` e não pode conter credenciais.

## Testes

`apps/mobile/src/**/*.test.ts{,x}` cobre o contrato do cliente HTTP, do serviço, do armazenamento, do gerenciador de sessão, das invariantes de segurança e das telas. Nenhum teste faz chamadas reais: `fetchImpl` é sempre injetado, exceto nos testes de integração que exigem `NEXUS_DATABASE_URL` e continuam restritos ao backend.

## Como executar localmente

```sh
# backend (na raiz); use as variáveis já documentadas em docs/AUTHENTICATION.md
NEXUS_DATABASE_URL=... NEXUS_SESSION_SECRET=... NEXUS_OWNER_PASSWORD=... npm run dev
```

No navegador, `npm run dev` abre o aplicativo em `http://localhost:5173` e o proxy de `/v1` encaminha para `NEXUS_DEV_API_PROXY` (padrão `http://127.0.0.1:3000`), evitando CORS em desenvolvimento.

Para o Android: `npm run build --workspace @nexus/mobile`, depois `npx cap sync android` em `apps/mobile` e abra `apps/mobile/android` no Android Studio. No dispositivo, defina o endereço da API em "Configurar endereço da API" usando o IP da máquina de desenvolvimento (por exemplo `http://192.168.0.10:3000`); `localhost` jamais funciona a partir do aparelho. Serve HTTP em texto claro apenas para desenvolvimento local — produção exige HTTPS.

## Limitações conhecidas

- **Build Gradle/APK não executado.** O ambiente usado para validar esta etapa não possui JVM nem Android SDK, portanto `gradlew assembleDebug` não pôde rodar. A compatibilidade foi verificada de forma estática: `npx cap sync android` conclui com sucesso, o plugin local está registrado em `MainActivity` antes de `super.onCreate` e a dependência `androidx.security:security-crypto` está declarada em `app/build.gradle`. A execução em dispositivo real e o comportamento do Keystore precisam ser confirmados no CI/Android Studio.
- **Recarga no navegador exige novo login.** Consequência deliberada do armazenamento apenas em memória na web.
- **Sem renovação de token.** O token expira no prazo emitido pelo servidor; ao expirar, a próxima validação leva à tela de login. Renovação não faz parte do contrato atual e não foi adicionada.
- **Bloqueio `429` é global.** É a política do backend existente, não algo introduzido aqui; o aplicativo apenas apresenta a mensagem.
- **Sem verificação de certificado fixada (pinning).** Fora do escopo de 3C.1.
- **YUI, ALICE e SCHWI, chat, histórico e ferramentas permanecem intocados** nesta etapa.
