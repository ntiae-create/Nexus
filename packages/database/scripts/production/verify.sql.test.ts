import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `30_verify.sql` precisa FALHAR quando um invariante nao se confirma.
 *
 * O defeito que estes testes guardam, encontrado em revisao: a versao anterior
 * do arquivo imprimia as contagens e terminava com "VERIFICACAO CONCLUIDA"
 * independentemente dos numeros. Um banco com 3 tabelas produzia a mesma
 * mensagem final que um banco correto — e o instalador seguia para "CONCLUIDO".
 *
 * Cada caso aqui viola UM invariante especifico e exige que o psql saia com
 * codigo != 0. Isso e o que transforma o arquivo de relatorio em verificacao.
 *
 * Estrategia: aplica as migrations num banco descartavel, confirma que o banco
 * valido passa, depois quebra um invariante de cada vez numa transacao que NAO
 * e confirmada. Nada toca banco real: o teste so roda quando
 * NEXUS_TEST_ADMIN_URL aponta para um PostgreSQL descartavel.
 */

const adminUrl = process.env.NEXUS_TEST_ADMIN_URL;
const describeIfPostgres = adminUrl ? describe : describe.skip;

// `new URL(".").pathname` devolve um caminho com barras ("/a/b/"), que NAO
// serve como nome de banco. O nome do banco descartavel e derivado apenas de
// pid+timestamp, com caracteres seguros para identifier.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = `${dirname(fileURLToPath(import.meta.url))}/`;
const verifySql = `${here}30_verify.sql`;
const grantSql = `${here}20_grant_runtime.sql`;
// sobe de scripts/production -> scripts -> database -> packages -> raiz
const repoRoot = dirname(dirname(dirname(dirname(here))));
const migrateSh = `${repoRoot}/packages/database/scripts/migrate.sh`;

/**
 * Resolve o binario do psql. O ambiente de teste nem sempre tem psql no PATH
 * mesmo com um cluster rodando — e um `beforeAll` que falha ao achar o binario
 * deixa todos os testes pulados, o que da aparencia de sucesso sem verificar
 * nada. Por isso a resolucao e explicita e a ausencia FALHA alto.
 */
function resolverPsql(): string {
  if (process.env.PSQL_BIN && existsSync(process.env.PSQL_BIN)) return process.env.PSQL_BIN;
  try {
    return execSync("command -v psql", { encoding: "utf8", shell: "/bin/sh" }).trim();
  } catch {
    const candidato = "/tmp/pypi/x/pgserver/pginstall/bin/psql";
    if (existsSync(candidato)) return candidato;
    throw new Error(
      "psql nao encontrado. Defina PSQL_BIN ou coloque psql no PATH para rodar os testes de integracao.",
    );
  }
}

const PSQL = adminUrl ? resolverPsql() : "psql";
const RUN = `nexus_verify_test_${process.pid}_${Date.now()}`;
const runUrl = adminUrl ? adminUrl.replace(/\/[^/?]+(\?.*)?$/, `/${RUN}`) : "";
/**
 * URL de conexao como `nexus_migrator` (o papel que aplica as migrations).
 * A 00008 depende de `nexus_record_deleted_entity` pertencer a ele; migrar como
 * `postgres` produziria dono `postgres` e a verificacao — corretamente — falha.
 * O cluster de teste usa `trust`, entao nao ha senha.
 */
function migratorUrl(): string {
  return runUrl.replace(/^(postgres(?:ql)?:\/\/)[^@/]*@/, "$1nexus_migrator@");
}

function psql(sql: string, opts: { stop?: boolean } = {}): string {
  const args = ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align"];
  if (opts.stop !== false) args.push("--set", "ON_ERROR_STOP=1");
  args.push("--dbname", runUrl, "--command", sql);
  return execFileSync(PSQL, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function psqlFile(file: string): string {
  return execFileSync(
    PSQL,
    ["--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--dbname", runUrl, "--file", file],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Roda 30_verify.sql e devolve { ok, saida }. Nao lanca: a falha e o dado. */
function runVerify(): { ok: boolean; saida: string; erro: string } {
  try {
    const saida = psqlFile(verifySql);
    return { ok: true, saida, erro: "" };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, saida: e.stdout ?? "", erro: e.stderr ?? String(error) };
  }
}


/**
 * Recria o banco descartavel do zero e aplica a sequencia real do procedimento:
 * papeis (fase 1) -> migrations como nexus_migrator -> grants de runtime (fase 2).
 *
 * Precisa ser chamado antes de CADA caso que viola um invariante: os casos
 * derrubam tabelas, alteram atributos de papel (global ao cluster) e inserem
 * linhas. Desfazer isso "na mao" e fragil e ja mascarou contaminacao entre
 * testes; recriar o banco e deterministico.
 */
function reproduzirBancoInicial(): void {
  const admin = adminUrl!;
  execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", admin, "-c",
    `DROP DATABASE IF EXISTS ${RUN} WITH (FORCE)`, "-c", `CREATE DATABASE ${RUN}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Os papeis sao objetos de CLUSTER: existem ou nao, independente do banco.
  // Recriar so o que falta mantem o teste repetivel num cluster reutilizado.
  execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", runUrl, "-c", `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexus_migrator') THEN
        CREATE ROLE nexus_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexus_audit_writer') THEN
        CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexus_app') THEN
        CREATE ROLE nexus_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexus_anonymous') THEN
        CREATE ROLE nexus_anonymous NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END $$;
  `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Estado de atributos e memberships pode ter sido alterado por um caso
  // anterior que falhou no meio; normaliza para o esperado.
  for (const sql of [
    "ALTER ROLE nexus_app NOBYPASSRLS NOSUPERUSER NOLOGIN",
    "ALTER ROLE nexus_audit_writer NOLOGIN NOBYPASSRLS NOSUPERUSER",
    "ALTER ROLE nexus_migrator NOSUPERUSER NOBYPASSRLS",
    "ALTER ROLE nexus_anonymous NOLOGIN NOBYPASSRLS NOSUPERUSER",
  ]) {
    execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", runUrl, "-c", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  // CREATE porque o ledger (schema nexus) e criado pelo proprio migrator;
  // CONNECT porque sem isso ele nem se conecta. Espelha 00_prepare.sql:102.
  execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", runUrl, "-c",
    `GRANT CREATE, CONNECT ON DATABASE ${RUN} TO nexus_migrator`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // O migrator precisa poder assumir o escritor (o ALTER FUNCTION ... OWNER TO
  // da 00007 depende disso). Na fase 1 real isso e um GRANT com SET TRUE.
  execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", runUrl, "-c",
    "GRANT nexus_audit_writer TO nexus_migrator WITH SET TRUE, INHERIT FALSE"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Migrations aplicadas COMO nexus_migrator — e o dono dos objetos, e a 00008
  // exige que nexus_record_deleted_entity pertenca a ele.
  execFileSync("sh", [migrateSh], {
    encoding: "utf8",
    env: { ...process.env, NEXUS_MIGRATION_DATABASE_URL: migratorUrl(), NEXUS_MIGRATE_ASSUME_YES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Grants de runtime (fase 2) por ultimo.
  execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", runUrl, "--file", grantSql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describeIfPostgres("30_verify.sql — invariantes obrigatorios", () => {
  beforeAll(reproduzirBancoInicial, 120_000);

  afterAll(() => {
    if (!adminUrl) return;
    try {
      execFileSync(PSQL, ["--no-psqlrc", "--quiet", "--dbname", adminUrl, "-c",
        `DROP DATABASE IF EXISTS ${RUN} WITH (FORCE)`], { stdio: "ignore" });
    } catch { /* banco descartavel; nao falhar o job por limpeza */ }
  });

  it("banco valido PASSA", () => {
    const r = runVerify();
    expect(r.erro).toBe("");
    expect(r.ok).toBe(true);
    expect(r.saida).toContain("VERIFICACAO CONCLUIDA");
  });

  it("segunda execucao continua idempotente e passa", () => {
    execFileSync("sh", [migrateSh], {
      encoding: "utf8",
      env: { ...process.env, NEXUS_MIGRATION_DATABASE_URL: migratorUrl(), NEXUS_MIGRATE_ASSUME_YES: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const r = runVerify();
    expect(r.ok).toBe(true);
  });

  // Cada caso viola um invariante, confirma que a verificacao FALHA, e desfaz.
  // O `ROLLBACK` e feito por um segundo comando, porque 30_verify.sql abre a
  // propria sessao: a violacao e aplicada e desfeita fora dela.
  const casos: Array<{ nome: string; violar: string; esperado: RegExp }> = [
    {
      nome: "ledger com migration faltando",
      violar: "DELETE FROM nexus_migrations.schema_migrations WHERE version = 8",
      esperado: /ledger tem 7|versoes ausentes/,
    },
    {
      nome: "tabela faltando (contagem errada)",
      violar: "DROP TABLE nexus.user_assistant_preferences",
      esperado: /tabelas, esperado 27|FORCE ROW LEVEL|policies/,
    },
    {
      nome: "FORCE RLS desligado numa tabela de dado pessoal",
      violar: "ALTER TABLE nexus.conversations NO FORCE ROW LEVEL SECURITY",
      // A falha pode vir pela lista de tabelas ou pela contagem global; ambas
      // nomeiam FORCE ROW LEVEL SECURITY e ambas impedem "CONCLUIDO".
      esperado: /sem FORCE RLS|FORCE ROW LEVEL SECURITY/,
    },
    {
      nome: "papel com BYPASSRLS",
      violar: "ALTER ROLE nexus_app BYPASSRLS",
      esperado: /SUPERUSER ou BYPASSRLS/,
    },
    {
      nome: "escritor pode fazer login",
      violar: "ALTER ROLE nexus_audit_writer LOGIN",
      esperado: /pode fazer login/,
    },
    {
      nome: "owner duplicado",
      // O proprio schema impede duas linhas: PK em `singleton` + check
      // `owner_identity_singleton_check` (singleton = true). Defesa em
      // profundidade — para exercitar o verificador e preciso remover a
      // constraint, que e o que este caso faz.
      violar: `ALTER TABLE nexus.owner_identity DROP CONSTRAINT owner_identity_singleton_check;
               INSERT INTO nexus.owner_identity (singleton, id)
               VALUES (false, '00000000-0000-4000-8000-000000000099')`,
      esperado: /owner_identity|linhas, esperado exatamente 1|singleton/,
    },
    {
      nome: "provider ficticio de teste no banco",
      violar: `INSERT INTO nexus.providers (id, provider_key, display_name, availability, cost_status)
               VALUES ('50000000-0000-4000-8000-0000000000ff','test-free','Test','available','free_confirmed')`,
      esperado: /providers de teste|bootstrap\.sql/,
    },
    {
      nome: "GRANT de runtime faltando",
      violar: "REVOKE INSERT ON nexus.conversations FROM nexus_app",
      esperado: /nao pode inserir|FALTA GRANT/,
    },
    {
      nome: "nexus_app pode escrever na trilha de auditoria",
      violar: "GRANT INSERT ON nexus.tool_grant_audit TO nexus_app",
      esperado: /trilha pode ser forjada|privilegio_indevido|INSERT em tool_grant_audit/,
    },
    {
      nome: "nexus_app pode escrever no catalogo",
      violar: "GRANT INSERT ON nexus.assistants TO nexus_app",
      esperado: /escrita no catalogo/,
    },
  ];

  for (const caso of casos) {
    it(`FALHA quando: ${caso.nome}`, () => {
      // Cada caso parte de um banco recem-provisionado. Tentar desfazer a
      // violacao "na mao" no finally e fragil — foi o que fez oito casos
      // falharem em cascata por contaminacao (linha residual em owner_identity,
      // tabela derrubada, atributo de papel global ao cluster).
      reproduzirBancoInicial();
      psql(caso.violar);
      const r = runVerify();
      expect(r.ok, `verificacao deveria falhar mas passou. saida: ${r.saida}`).toBe(false);
      expect(r.erro).toMatch(caso.esperado);
      expect(r.saida).not.toContain("VERIFICACAO CONCLUIDA");
    }, 120_000);
  }
});

describe("30_verify.sql — estrutura do arquivo", () => {
  it("existe e usa ON_ERROR_STOP", () => {
    expect(existsSync(verifySql)).toBe(true);
    const conteudo = require("node:fs").readFileSync(verifySql, "utf8") as string;
    expect(conteudo).toContain("\\set ON_ERROR_STOP on");
  });

  it("tem RAISE EXCEPTION para cada familia de invariante", () => {
    const conteudo = require("node:fs").readFileSync(verifySql, "utf8") as string;
    for (const invariante of [
      /FALHA: ledger/,
      /FALHA: schema nexus tem/,
      /FALHA: .*FORCE ROW LEVEL SECURITY/,
      /FALHA: .*policies de RLS/,
      /FALHA: papel .* nao existe/,
      /FALHA: .*SUPERUSER ou BYPASSRLS/,
      /FALHA: record_deleted_entity pertence/,
      /FALHA: audit_tool_grant_change pertence/,
      /FALHA: nexus\.owner_identity tem/,
      /FALHA: .*providers de teste/,
      /FALHA: nexus_app nao pode inserir/,
      /FALHA: nexus_app tem INSERT em tool_grant_audit/,
    ]) {
      expect(conteudo).toMatch(invariante);
    }
  });

  it("a mensagem final de sucesso so aparece depois dos invariantes", () => {
    const conteudo = require("node:fs").readFileSync(verifySql, "utf8") as string;
    // O texto "VERIFICACAO CONCLUIDA" tambem aparece no comentario do cabecalho,
    // entao a comparacao usa a ULTIMA ocorrencia — o \echo que realmente imprime.
    const ultimaFalha = conteudo.lastIndexOf("RAISE EXCEPTION");
    const conclusao = conteudo.lastIndexOf("VERIFICACAO CONCLUIDA");
    expect(conclusao).toBeGreaterThan(ultimaFalha);
    // E nao pode haver nenhum DO $$ ... RAISE EXCEPTION depois do echo final.
    expect(conteudo.slice(conclusao)).not.toContain("RAISE EXCEPTION");
  });
});
