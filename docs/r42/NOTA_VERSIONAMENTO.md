# Nota de versionamento — artefatos de auditoria

## O que entra no Git e o que não

`*.log` está no `.gitignore` do repositório. Os logs de execução das rodadas **não são
versionados** — são transcrições reproduzíveis, não artefatos de código.

Consequência prática: os manifestos `MANIFEST_r41.md5` e `MANIFEST_r42.md5` listam entradas
de log que existem no ambiente local mas não no repositório. Num clone limpo, `md5sum -c`
nesses manifestos acusará "FAILED open or read" para essas linhas.

**Isso não é corrupção.** Os artefatos que importam — scripts, diffs, provas em `.txt` e
documentos `.md` — estão versionados e conferem.

## Verificação num clone limpo

```bash
# confere só o que foi versionado
md5sum -c docs/r42/MANIFEST_r42.md5 2>/dev/null | grep -v '\.log'
```

## Manifestos por estado

| manifesto | arquivos | íntegros localmente | observação |
|---|---|---|---|
| `docs/r38/MANIFEST.md5` | 29 | 26 | 3 artefatos alterados depois por R40/R41/R42 |
| `docs/r40/MANIFEST_r40.md5` | 14 | 9 | 5 logs perdidos por ambiente (ver `docs/r40/NOTA_INTEGRIDADE.md`) |
| `docs/r41/MANIFEST_r41.md5` | 13 | 13 | íntegro |
| `docs/r42/MANIFEST_r42.md5` | 11 | 11 | íntegro |

## Por que versionar os artefatos de auditoria

Cada rodada alterou scripts e testes que passaram a depender de decisões registradas nos
relatórios (por exemplo: por que `DROP OWNED` roda antes de `DROP DATABASE`; por que a
asserção espera 42501 e não 23503). Sem esses documentos no histórico, o próximo leitor
não consegue reconstruir o raciocínio a partir do código.
