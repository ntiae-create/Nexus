# Autenticação: tentativas e revogação

## Tentativas de login

O PostgreSQL é a autoridade compartilhada entre instâncias (não há contador em memória por processo). Uma única linha singleton é atualizada sob `SELECT ... FOR UPDATE`, serializando tentativas inválidas de todos os workers. As primeiras quatro falhas em uma janela de 15 minutos recebem `401`; a quinta e as seguintes durante o bloqueio recebem `429`. O bloqueio expira após 15 minutos; novas falhas depois do prazo iniciam nova janela.

**Recuperação do proprietário:** uma senha correta é verificada antes de contar uma falha e limpa o estado de bloqueio. Assim, alguém sem a senha não pode manter o proprietário bloqueado indefinidamente, enquanto o atraso e o limite continuam valendo para tentativas incorretas. Isso não protege contra comprometimento da senha nem substitui controles de rede/WAF. A política é global para a identidade única, não por IP; ataques distribuídos podem causar `429` para tentativas incorretas legítimas durante o prazo.

O contador não armazena senha, IP ou conteúdo de requisição. A migração `00002_auth_security.sql` cria o estado; deve ser aplicada nos ambientes antes de habilitar o plugin com autenticação configurada.

## Tokens revogados e limpeza

Logout persiste o `jti` e o instante de expiração do token no PostgreSQL. A verificação consulta a tabela compartilhada. A limpeza remove apenas linhas com `expires_at <= now()`; esse limite é deliberado: a linha fica presente durante todo o intervalo em que o JWT poderia ser aceito. A operação é feita após novos registros de revogação e usa o índice `revoked_sessions_expires_at_idx`.

Não existe job externo nem pressuposto sobre cron do provedor. Se houver logouts, a própria gravação faz a coleta; durante períodos sem logouts o volume também não cresce, pois nenhum registro novo é incluído. Pode haver retenção temporária de expirados depois de um pico de logouts até a próxima revogação, mas eles não autenticam. Uma manutenção agendada pode executar `DELETE FROM nexus.revoked_sessions WHERE expires_at <= now()` com a mesma condição, nunca apagando sessões ainda válidas.
