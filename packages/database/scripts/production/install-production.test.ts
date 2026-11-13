import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * O instalador precisa de duas garantias que ele NAO tinha, e que foram
 * encontradas em revisao do PR #14:
 *
 *   1. falha do psql na verificacao final produz exit code != 0;
 *   2. o instalador nunca imprime "CONCLUIDO" quando a verificacao falha.
 *
 * O defeito original era
 *
 *     psql ... --file 30_verify.sql 2>&1 | redact
 *
 * e o shell reporta o status do `redact` (sempre 0), nao do `psql`. Provar isso
 * com o script real exige um PostgreSQL; provar a PROPRIEDADE (que o script
 * trata o status do psql) pode ser feito com um psql falso, e e o que estes
 * testes fazem — sem depender de banco para rodar.
 *
 * Os testes com banco de verdade ficam em verify.sql.test.ts.
 */

const here = new URL(".", import.meta.url).pathname;
const script = `${here}install-production.sh`;

describe("install-production.sh — falha na verificacao", () => {
  let fakeBin: string;
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "nexus-install-"));
    fakeBin = join(workdir, "bin");
    execFileSync("mkdir", ["-p", fakeBin]);

    // `psql` falso: responde com sucesso a tudo, MENOS o arquivo 30_verify.sql,
    // que falha com a mensagem de invariante que o script deve repassar.
    // As senhas sao lidas de stdin pelo script; aqui ele nao e interativo.
    const psql = `#!/bin/sh
# --file <arquivo> ... : falha se o arquivo for 30_verify.sql
for arg in "$@"; do
  case "$arg" in
    *30_verify.sql)
      echo "psql:$arg: ERROR:  FALHA: ledger tem 7 migrations, esperado 8" >&2
      exit 3
      ;;
  esac
done
exit 0
`;
    writeFileSync(join(fakeBin, "psql"), psql);
    chmodSync(join(fakeBin, "psql"), 0o755);

    // `stty` falso: sem TTY nos testes, o script usa `stty -echo || true`.
    writeFileSync(join(fakeBin, "stty"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeBin, "stty"), 0o755);
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  /** Alimenta as 4 senhas que o instalador pede e devolve o resultado. */
  function run(opts: { verifyFails?: boolean } = {}): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    if (opts.verifyFails === false) {
      // psql que sempre passa, para o caminho feliz
      writeFileSync(join(fakeBin, "psql"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(fakeBin, "psql"), 0o755);
    }
    const r = spawnSync("sh", [script], {
      encoding: "utf8",
      input: "senha-admin-1234\nsenha-migrador-1234\nsenha-app-12345678\nsenha-migrador-1234\n",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PGHOST: "127.0.0.1",
        PGPORT: "1",
        PGDATABASE: "railway",
        PSQL_BIN: join(fakeBin, "psql"),
      },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("sai com codigo != 0 quando a verificacao falha", () => {
    const r = run({ verifyFails: true });
    expect(r.status).not.toBe(0);
  });

  it("NAO imprime CONCLUIDO quando a verificacao falha", () => {
    const r = run({ verifyFails: true });
    // A mensagem de falha vai para stderr (e diagnostico de erro); o que importa
    // e que o sucesso NAO apareca em lugar nenhum.
    expect(r.stdout).not.toContain("CONCLUIDO");
    expect(r.stderr).toContain("VERIFICACAO FALHOU");
  });

  it("repassa a mensagem do invariante violado", () => {
    const r = run({ verifyFails: true });
    expect(r.stderr).toContain("FALHA: ledger tem 7 migrations, esperado 8");
  });

  it("nao vaza senha nem URL com credencial no log de falha", () => {
    const r = run({ verifyFails: true });
    const tudo = r.stdout + r.stderr;
    for (const segredo of [
      "senha-admin-1234",
      "senha-migrador-1234",
      "senha-app-12345678",
    ]) {
      expect(tudo).not.toContain(segredo);
    }
    expect(tudo).not.toMatch(/postgresql:\/\/[^ :]+:[^ @]+@/);
  });
});

describe("install-production.sh — estrutura (sem executar)", () => {
  const conteudo = readFileSync(script, "utf8");

  it("nao usa pipe para o psql da verificacao", () => {
    // A regressao exata: `psql ... --file 30_verify.sql 2>&1 | redact` faz o
    // status vir do `redact` (sempre 0). O comando do psql se estende por
    // continuadores de linha, entao a checagem e feita no bloco inteiro:
    // pega da mencao a 30_verify.sql ate o fim do comando (a primeira linha
    // que nao termina em barra invertida).
    const linhas = conteudo.split("\n");
    const idx = linhas.findIndex((l) => l.includes("30_verify.sql") && l.includes("--file"));
    expect(idx).toBeGreaterThan(-1);

    // Junta o comando completo a partir de algumas linhas antes.
    let bloco = "";
    for (let i = idx; i < linhas.length; i++) {
      const l = linhas[i];
      if (l.trimStart().startsWith("#")) continue;
      bloco += l;
      if (!l.trimEnd().endsWith("\\")) break;
      bloco += " ";
    }
    // Dentro do comando que roda o verificador nao pode haver pipe.
    expect(bloco).not.toMatch(/\|\s*redact/);
    expect(bloco).not.toMatch(/\|\s*$/);
  });

  it("checa o status da verificacao explicitamente", () => {
    expect(conteudo).toMatch(/if ! PGPASSWORD=\$PW_migrator_pw[\s\S]{0,400}30_verify\.sql[\s\S]{0,200}then/);
    expect(conteudo).toContain("VERIFICACAO FALHOU");
    expect(conteudo).toContain("exit 1");
  });

  it("o CONCLUIDO so aparece depois do bloco de falha da verificacao", () => {
    const falha = conteudo.indexOf("VERIFICACAO FALHOU");
    const concluido = conteudo.indexOf('echo "CONCLUIDO"');
    expect(falha).toBeGreaterThan(0);
    expect(concluido).toBeGreaterThan(falha);
  });

  it("usa ON_ERROR_STOP na verificacao", () => {
    expect(conteudo).toMatch(/--set ON_ERROR_STOP=1[\s\S]{0,120}30_verify\.sql/);
  });
});

describe("arquivos de producao — presenca e nomes reais", () => {
  const arquivos = [
    "00_prepare.sql",
    "20_grant_runtime.sql",
    "30_verify.sql",
    "install-production.sh",
  ];

  for (const f of arquivos) {
    it(`existe: ${f}`, () => {
      expect(existsSync(`${here}${f}`)).toBe(true);
    });
  }
});
