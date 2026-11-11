# Nota de integridade — manifesto R40

`docs/r40/MANIFEST_r40.md5` lista 14 arquivos, dos quais **5 não existem mais** no working tree:

```
docs/r40/logs/instalacao.log     FAILED open or read
docs/r40/logs/integration.log    FAILED open or read
docs/r40/logs/isolamento.log     FAILED open or read
docs/r40/logs/npm_test.log       FAILED open or read
docs/r40/logs/sabotagem.log      FAILED open or read
```

**Causa:** perda de ambiente (o `/tmp` e o working tree efêmero já foram zerados entre rodadas
nesta sessão; os logs do R40 estavam presentes quando o manifesto foi gerado).

**Impacto:** nenhum sobre o código. Os logs são transcrições de execução; os artefatos que importam
— `pg_cleanup.sh` corrigido, o diff e as provas (`prova/*.txt`) — **conferem**. As provas do R40
foram supersedidas pelas do R41/R42, cujos manifestos validam 100% (13/13 e 11/11).

**Decisão:** o diretório `docs/r40` é versionado **com esta nota**, para que o manifesto incompleto
não seja lido como corrupção silenciosa. Nenhum hash foi reescrito e nenhum arquivo foi apagado.

## Estado dos manifestos no momento do commit

| manifesto | arquivos | conferem | observação |
|---|---|---|---|
| `docs/r38/MANIFEST.md5` | 29 | 26 | 3 alterados **depois** por R40/R41/R42 (esperado; hashes novos registrados nas rodadas seguintes) |
| `docs/r40/MANIFEST_r40.md5` | 14 | 9 | 5 logs perdidos por ambiente |
| `docs/r41/MANIFEST_r41.md5` | 13 | 13 | íntegro |
| `docs/r42/MANIFEST_r42.md5` | 11 | 11 | íntegro |
