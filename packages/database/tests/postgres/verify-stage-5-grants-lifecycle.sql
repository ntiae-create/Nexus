\set ON_ERROR_STOP on
-- Fase 5 (G13): ciclo de vida de `tool_grants`, auditoria de eventos e ACL dos tipos.
--
-- =============================================================================================
-- O QUE ESTE ARQUIVO PROVA
-- =============================================================================================
-- §A  INSERT so nasce `granted`; `revoked` e terminal e imutavel; escopo e proveniencia fixos.
-- §B  A trilha registra EXATAMENTE um evento por transicao — nunca zero, nunca dois.
-- §C  ACL: os enums de 00007 nao tem `USAGE` para PUBLIC; `nexus_app` e `nexus_audit_writer` tem.
-- §D  O papel escritor da trilha e seguro: NOLOGIN, NOSUPERUSER, NOBYPASSRLS, e o dono da funcao.
--
-- Roda como `postgres` (dono do schema). Transacoes com ROLLBACK: nada persiste.
-- =============================================================================================
-- PRE-CONDICAO: banco recem-criado
-- =============================================================================================
DO $$
BEGIN
  IF current_database() <> 'nexus_test' THEN
    RAISE EXCEPTION 'Expected isolated nexus_test database, got %', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM nexus.tool_grants) OR EXISTS (SELECT 1 FROM nexus.tool_grant_audit) THEN
    RAISE EXCEPTION
      'Lifecycle verification requires a fresh database: Phase 5 tables are not empty.'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- =============================================================================================
-- §A. Ciclo de vida (enforce_tool_grant_lifecycle)
-- =============================================================================================
BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

DO $$
DECLARE
  owner uuid := nexus.current_owner_id();
  other_owner uuid := '99999999-0000-4000-8000-000000000001';
  assistant_a uuid := '00000000-0000-4000-8000-000000000001';
  assistant_b uuid := '00000000-0000-4000-8000-000000000003';
  target_grant uuid := 'e0000000-0000-4000-8000-000000000001';
  probe_id uuid := 'e0000000-0000-4000-8000-0000000000ff';
  rejected boolean;
  audit_events integer;
BEGIN
  -- (1) INSERT com status revogado: proibido. Nao existe historico que comece revogado.
  rejected := false;
  BEGIN
    INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id,
                                   granted_at, revoked_by_owner_id, revoked_at)
    VALUES (probe_id, owner, assistant_a, 'personal.tasks', 'revoked', owner,
            now(), owner, now());
    EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'INSERT with status=revoked was accepted';
  END IF;

  -- INSERT ativo ja nasce com um evento de auditoria.
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES (target_grant, owner, assistant_a, 'personal.tasks', 'granted', owner, now());

  SELECT count(*) INTO audit_events FROM nexus.tool_grant_audit a WHERE a.grant_id = target_grant;
  IF audit_events <> 1 THEN
    RAISE EXCEPTION 'Grant insert must produce exactly 1 audit row, found %', audit_events;
  END IF;

  -- (1b) granted -> granted e REJEITADO, inclusive tocar apenas `updated_at`.
  -- Um grant ativo nao e editavel: toda escrita ou e a concessao (INSERT) ou a revogacao.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET updated_at = now() WHERE id = target_grant;
    RAISE EXCEPTION 'granted -> granted touching only updated_at was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'granted -> granted touching only updated_at was accepted';
  END IF;

  -- Qualquer outro campo de uma linha ativa tambem e imutavel.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET created_at = created_at - interval '1 hour' WHERE id = target_grant;
    RAISE EXCEPTION 'granted -> granted touching created_at was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'granted -> granted touching created_at was accepted';
  END IF;

  -- E nenhuma dessas tentativas pode ter gerado evento: continua exatamente 1.
  SELECT count(*) INTO audit_events FROM nexus.tool_grant_audit a WHERE a.grant_id = target_grant;
  IF audit_events <> 1 THEN
    RAISE EXCEPTION 'Rejected no-op updates produced audit rows, found %', audit_events;
  END IF;

  -- (1c) ISOLAMENTO DAS DUAS BARREIRAS. `granted -> granted` e barrado por DOIS lugares: o
  -- trigger BEFORE de lifecycle (42501 "Active tool grant is immutable") e o trigger AFTER de
  -- auditoria (42501 "update without status change"). Se um dos dois for removido por engano, o
  -- outro ainda segura a escrita — o que e bom — mas o teste nao percebe qual sumiu. Aqui
  -- verificamos a MENSAGEM, para garantir que a barreira primaria (lifecycle) esta ativa.
  BEGIN
    UPDATE nexus.tool_grants SET updated_at = now() WHERE id = target_grant;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('immutable' in SQLERRM) = 0 THEN
      RAISE EXCEPTION
        'granted -> granted was rejected, but not by the lifecycle trigger (message: %)', SQLERRM;
    END IF;
  END;

  -- (2) granted -> revoked: a unica transicao permitida, e ela audita.
  UPDATE nexus.tool_grants
  SET status = 'revoked', revoked_by_owner_id = owner, revoked_at = now()
  WHERE id = target_grant;

  SELECT count(*) INTO audit_events FROM nexus.tool_grant_audit a WHERE a.grant_id = target_grant;
  IF audit_events <> 2 THEN
    RAISE EXCEPTION 'Grant + revoke must produce exactly 2 audit rows, found %', audit_events;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexus.tool_grant_audit a
    WHERE a.grant_id = target_grant AND a.action = 'revoked' AND a.actor_owner_id = owner
  ) THEN
    RAISE EXCEPTION 'Revocation audit row missing or wrong';
  END IF;

  -- (4) revoked -> granted: proibido.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants
    SET status = 'granted', revoked_by_owner_id = NULL, revoked_at = NULL
    WHERE id = target_grant;
    RAISE EXCEPTION 'revoked -> granted was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'revoked -> granted was accepted';
  END IF;

  -- (5a) revoked -> revoked alterando revoked_at: proibido.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET revoked_at = now() + interval '1 hour' WHERE id = target_grant;
    RAISE EXCEPTION 'revoked -> revoked with new revoked_at was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'revoked -> revoked with new revoked_at was accepted';
  END IF;

  -- (5b) revoked -> revoked alterando revoked_by_owner_id: proibido.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET revoked_by_owner_id = other_owner WHERE id = target_grant;
    RAISE EXCEPTION 'revoked -> revoked with new revoked_by_owner_id was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'revoked -> revoked with new revoked_by_owner_id was accepted';
  END IF;

  -- (5c) qualquer outro campo apos revogacao: proibido.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET updated_at = now() WHERE id = target_grant;
    RAISE EXCEPTION 'Field update after revocation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Field update after revocation was accepted';
  END IF;

  -- (6) escopo imutavel: owner_id, assistant_id e tool_id.
  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET owner_id = other_owner WHERE id = target_grant;
    RAISE EXCEPTION 'owner_id mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'owner_id mutation was accepted';
  END IF;

  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET assistant_id = assistant_b WHERE id = target_grant;
    RAISE EXCEPTION 'assistant_id mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'assistant_id mutation was accepted';
  END IF;

  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET tool_id = 'personal.organize' WHERE id = target_grant;
    RAISE EXCEPTION 'tool_id mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'tool_id mutation was accepted';
  END IF;

  -- (7) proveniencia imutavel: granted_by / granted_at nao podem ser reescritos.
  -- Usa uma linha NOVA (a anterior ja esta revogada e seria barrada antes pelo teste (5c)).
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES (probe_id, owner, assistant_b, 'technical.code_analysis', 'granted', owner, now() - interval '2 days');

  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET granted_at = now() WHERE id = probe_id;
    RAISE EXCEPTION 'granted_at mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'granted_at mutation was accepted';
  END IF;

  rejected := false;
  BEGIN
    UPDATE nexus.tool_grants SET granted_by_owner_id = other_owner WHERE id = probe_id;
    RAISE EXCEPTION 'granted_by_owner_id mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'granted_by_owner_id mutation was accepted';
  END IF;

  -- Nenhuma das tentativas acima pode ter gerado evento.
  SELECT count(*) INTO audit_events FROM nexus.tool_grant_audit;
  IF audit_events <> 3 THEN
    RAISE EXCEPTION 'Rejected mutations produced audit rows: found % events, expected 3', audit_events;
  END IF;

  RAISE NOTICE 'Lifecycle: 1 grant + 1 revoke audited, 11 mutations rejected';
END
$$;

-- Verifica no catalogo que a trilha continua sem policy de UPDATE/DELETE.
DO $$
DECLARE
  forbidden integer;
BEGIN
  SELECT count(*) INTO forbidden FROM pg_policies
  WHERE schemaname = 'nexus' AND tablename = 'tool_grant_audit' AND cmd IN ('UPDATE', 'DELETE');
  IF forbidden <> 0 THEN
    RAISE EXCEPTION 'Audit trail must not have UPDATE/DELETE policies, found %', forbidden;
  END IF;
END
$$;

ROLLBACK;

-- =============================================================================================
-- §C. ACL dos enums
-- =============================================================================================
DO $$
DECLARE
  t record;
  public_usage integer;
  app_usage integer;
  writer_usage integer;
BEGIN
  FOR t IN
    SELECT typname, oid FROM pg_type
    WHERE typnamespace = 'nexus'::regnamespace AND typname IN ('tool_grant_status', 'tool_grant_action')
  LOOP
    -- `typacl` NULL significa "default do tipo": PUBLIC=USAGE. Depois do REVOKE, a ACL e explicita.
    IF (SELECT typacl FROM pg_type WHERE oid = t.oid) IS NULL THEN
      RAISE EXCEPTION 'Type % still has NULL acl (default PUBLIC=USAGE)', t.typname;
    END IF;

    SELECT count(*) INTO public_usage
    FROM aclexplode((SELECT typacl FROM pg_type WHERE oid = t.oid)) a
    WHERE a.grantee = 0 AND a.privilege_type = 'USAGE';

    SELECT count(*) INTO app_usage
    FROM aclexplode((SELECT typacl FROM pg_type WHERE oid = t.oid)) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = 'nexus_app' AND a.privilege_type = 'USAGE';

    SELECT count(*) INTO writer_usage
    FROM aclexplode((SELECT typacl FROM pg_type WHERE oid = t.oid)) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = 'nexus_audit_writer' AND a.privilege_type = 'USAGE';

    IF public_usage <> 0 THEN
      RAISE EXCEPTION 'Type % still grants USAGE to PUBLIC', t.typname;
    END IF;
    IF app_usage <> 1 THEN
      RAISE EXCEPTION 'Type % must grant USAGE to nexus_app', t.typname;
    END IF;
    IF writer_usage <> 1 THEN
      RAISE EXCEPTION 'Type % must grant USAGE to nexus_audit_writer', t.typname;
    END IF;
  END LOOP;

  RAISE NOTICE 'Enum ACL: PUBLIC revoked; nexus_app + nexus_audit_writer have USAGE';
END
$$;

-- Nenhum papel INESPERADO recebe privilegio nos dois tipos.
--
-- `os DETENTORES DA PROPRIEDADE` sao aceitos por construcao: em PostgreSQL o dono de um objeto
-- tem todos os privilegios sobre ele, independentemente de ACL. Quando o provisionador aplica as
-- migrations como dono do schema (`nexus_migrator`), ele se torna dono destes tipos e aparece na
-- ACL com `=U/`. Isso NAO e vazamento e NAO pode ser revogado — tentar `REVOKE` do dono e no-op.
-- A versao anterior desta verificacao listava apenas `postgres` como dono aceito e por isso
-- acusava falso positivo em qualquer provisionamento real que nao fosse o superusuario.
--
-- O que a verificacao DEVE garantir e: (a) PUBLIC nao tem USAGE; (b) ninguem alem do dono e dos
-- dois papeis funcionais (`nexus_app`, `nexus_audit_writer`) aparece na ACL.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(DISTINCT coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ', ')
    INTO offender
  FROM pg_type t
  CROSS JOIN LATERAL aclexplode(t.typacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE t.typnamespace = 'nexus'::regnamespace
    AND t.typname IN ('tool_grant_status', 'tool_grant_action')
    AND coalesce(r.rolname, 'PUBLIC') NOT IN ('nexus_app', 'nexus_audit_writer')
    -- isenta o(s) dono(s) do proprio tipo, seja qual for o papel de provisionamento
    AND a.grantee <> t.typowner;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected privilege on Phase 5 enums: %', offender;
  END IF;

  -- PUBLIC nao e coberto pelo predicado acima (grants a PUBLIC tem grantee = 0 e nao aparecem em
  -- pg_roles). Ele ja e verificado de forma exaustiva em §C1.2 (linhas ~278-291), que percorre
  -- aclexplode e falha com "Type ... still grants USAGE to PUBLIC". Nao duplicamos aqui.
END
$$;

-- =============================================================================================
-- §D1. Papel escritor da trilha e SECURITY DEFINER
-- =============================================================================================
DO $$
DECLARE
  r record;
  fn record;
BEGIN
  SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    INTO r FROM pg_roles WHERE rolname = 'nexus_audit_writer';
  IF r IS NULL THEN
    RAISE EXCEPTION 'Role nexus_audit_writer does not exist';
  END IF;
  IF r.rolcanlogin THEN RAISE EXCEPTION 'nexus_audit_writer must be NOLOGIN (rolcanlogin = true)'; END IF;
  IF r.rolsuper THEN RAISE EXCEPTION 'nexus_audit_writer must be NOSUPERUSER (rolsuper = true)'; END IF;
  IF r.rolbypassrls THEN RAISE EXCEPTION 'nexus_audit_writer must be NOBYPASSRLS (rolbypassrls = true)'; END IF;
  -- Assercoes SEPARADAS: agrupar `rolcreatedb OR rolcreaterole` numa unica mensagem esconderia
  -- qual dos dois atributos regrediu, e cada um tem consequencia distinta (criar bancos x criar
  -- papeis). Consulta `pg_roles`, o estado real, nao o texto do `CREATE ROLE`.
  IF r.rolcreatedb THEN
    RAISE EXCEPTION 'nexus_audit_writer must be NOCREATEDB (rolcreatedb = true)';
  END IF;
  IF r.rolcreaterole THEN
    RAISE EXCEPTION 'nexus_audit_writer must be NOCREATEROLE (rolcreaterole = true)';
  END IF;

  SELECT p.proname, p.prosecdef, p.proconfig,
         pg_get_userbyid(p.proowner) AS fn_owner,
         p.proacl
    INTO fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'nexus' AND p.proname = 'audit_tool_grant_change';
  IF fn IS NULL THEN
    RAISE EXCEPTION 'audit_tool_grant_change() is missing';
  END IF;
  IF NOT fn.prosecdef THEN
    RAISE EXCEPTION 'audit_tool_grant_change() must be SECURITY DEFINER';
  END IF;
  IF fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'audit_tool_grant_change() must pin search_path=pg_catalog, found %', fn.proconfig;
  END IF;
  IF fn.fn_owner IS DISTINCT FROM 'nexus_audit_writer' THEN
    RAISE EXCEPTION 'audit_tool_grant_change() must be owned by nexus_audit_writer, found %', fn.fn_owner;
  END IF;

  -- Sem EXECUTE para PUBLIC nem para nexus_app: a funcao so roda como trigger.
  IF EXISTS (
    SELECT 1 FROM aclexplode(fn.proacl) a
    WHERE a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0
           OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'nexus_app'))
  ) THEN
    RAISE EXCEPTION 'audit_tool_grant_change() is executable by PUBLIC or nexus_app';
  END IF;

  -- A policy de INSERT da trilha e escopada ao papel escritor.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'nexus' AND tablename = 'tool_grant_audit'
      AND policyname = 'tool_grant_audit_writer_insert' AND cmd = 'INSERT'
      AND roles = ARRAY['nexus_audit_writer']::name[]
  ) THEN
    RAISE EXCEPTION 'tool_grant_audit_writer_insert must exist and be scoped to nexus_audit_writer';
  END IF;

  RAISE NOTICE 'Audit writer role is least-privilege and the definer function is correctly constrained';
END
$$;

-- =============================================================================================
-- §C2. Policy de INSERT da trilha: restrita ao escritor E coerente com o contexto
-- =============================================================================================
-- A policy deixou de ser `WITH CHECK (true)`. Ela exige que a linha gravada tenha
-- `owner_id = current_owner_id() = configured_owner_id()` e `actor_owner_id = owner_id`.
-- Provamos os quatro casos exigidos pela revisao.
BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

DO $$
DECLARE
  owner uuid := nexus.current_owner_id();
  other uuid := '99999999-0000-4000-8000-000000000001';
  c2_grant uuid := 'e0000000-0000-4000-8000-0000000000c2';
BEGIN
  -- 1. Insercao VALIDA pelo trigger (caminho normal da aplicacao).
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES (c2_grant, owner, '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', owner, now());

  IF (SELECT count(*) FROM nexus.tool_grant_audit a WHERE a.grant_id = c2_grant) <> 1 THEN
    RAISE EXCEPTION 'Valid grant produced no audit row';
  END IF;
  RAISE NOTICE 'C2.1) insercao valida pelo trigger: 1 evento';
END
$$;

-- 2/3. Dono ou actor divergentes: a policy recusa. O teste troca os GUCs para um contexto de
-- owner diferente e tenta inserir direto na trilha (sem passar pelo trigger de grants).
DO $$
DECLARE
  rejected boolean;
  owner uuid := nexus.current_owner_id();
  other uuid := '99999999-0000-4000-8000-000000000001';
BEGIN
  -- CONTEXTO: a FK `tool_grant_audit_owner_id_fkey` roda ANTES da RLS (acoes de integridade nao
  -- passam pelo RLS). Portanto testar com um `owner_id` INEXISTENTE nao prova nada sobre a
  -- policy: quem recusa e a FK. E `owner_identity` e singleton, entao nao existe "segundo owner
  -- real" para usar. A forma de isolar a policy e assumir o papel escritor e variar apenas o
  -- contexto do GUC: a FK satisfaz (o owner existe) e so a policy pode recusar.
  SET LOCAL ROLE nexus_audit_writer;

  -- 2. Owner da LINHA diferente do contexto da transacao: o GUC aponta para um uuid que nao e o
  -- do owner real, a linha usa o owner real. FK satisfaz; a policy recusa.
  PERFORM set_config('nexus.owner_id', other::text, true);
  rejected := false;
  BEGIN
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES (owner, 'e0000000-0000-4000-8000-0000000000c3',
            '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', owner);
    RAISE EXCEPTION 'Audit row with owner_id outside the transaction context was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Audit row with owner_id outside the transaction context was accepted';
  END IF;

  -- 3. Actor divergente: contexto restaurado, owner da linha correto, mas `actor_owner_id`
  -- diferente do owner. A policy recusa; o CHECK `actor_owner_id = owner_id` e a segunda
  -- barreira.
  PERFORM set_config('nexus.owner_id', owner::text, true);
  rejected := false;
  BEGIN
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES (owner, 'e0000000-0000-4000-8000-0000000000c4',
            '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', other);
    RAISE EXCEPTION 'Audit row with divergent actor was accepted';
  EXCEPTION WHEN SQLSTATE '42501' OR check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Audit row with divergent actor was accepted'; END IF;

  -- 4. Controle POSITIVO: com o contexto de volta ao owner correto, o MESMO papel consegue
  -- inserir. Sem isso os dois testes acima passariam por qualquer motivo (inclusive falta de
  -- privilegio), e nao por causa da policy.
  INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
  VALUES (owner, 'e0000000-0000-4000-8000-0000000000c6',
          '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', owner);
  RAISE NOTICE 'C2.control) mesma linha, contexto correto: aceita (prova que a recusa e da policy)';

  -- 3b. CONTEXTO AUSENTE: nenhum GUC definido. `current_owner_id()` devolve NULL e a comparacao
  -- `owner_id = NULL` resulta NULL; `WITH CHECK` so aceita TRUE, entao o INSERT e recusado.
  -- (Roda AINDA como nexus_audit_writer: depois do RESET ROLE quem executaria seria o dono, que
  -- nao passa por RLS sem policy — ver C2.4c.)
  PERFORM set_config('nexus.owner_id', '', true);
  rejected := false;
  BEGIN
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES (owner, 'e0000000-0000-4000-8000-0000000000c7',
            '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', owner);
    RAISE EXCEPTION 'Audit insert without owner context was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Audit insert without owner context was accepted'; END IF;

  -- Restaura o contexto para o controle positivo abaixo.
  PERFORM set_config('nexus.owner_id', owner::text, true);

  RAISE NOTICE 'C2.2/C2.3/C2.3b) owner divergente, actor divergente e contexto ausente: recusados pela policy';

  RESET ROLE;
END
$$;

-- 4c. LIMITE CONHECIDO E EXPLICITO: FORCE ROW LEVEL SECURITY NAO protege contra o dono da tabela
-- e, com mais razao, contra SUPERUSER/BYPASSRLS. Um superusuario consegue inserir na trilha sem
-- nenhuma policy de INSERT e sem contexto. Isso NAO e um defeito da policy: e o modelo do
-- PostgreSQL (documentado em R28). Registramos aqui para que ninguem leia "FORCE RLS" como
-- "a trilha e imutavel ate para o DBA".
-- Este bloco so pode ser executado por um SUPERUSER. Ele roda CONDICIONALMENTE: em instalacao
-- real o runner normalmente NAO e superusuario (ver R36), e nesse caso o limite e registrado sem
-- ser reexecutado. A prova positiva do limite continua valendo quando o runner e superusuario
-- (o harness de CI e o `run_pg17.sh`), e nao ha falso negativo: se o runner for superusuario e o
-- INSERT falhar, isso significa que o modelo do PostgreSQL mudou e o teste quebra de proposito.
DO $$
DECLARE
  inserted boolean := false;
  is_super boolean;
BEGIN
  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname = current_user;
  IF NOT coalesce(is_super, false) THEN
    RAISE NOTICE 'C2.4c) LIMITE DOCUMENTADO: runner nao e superusuario; prova de bypass nao executavel aqui (esperado em instalacao real)';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES ('00000000-0000-4000-8000-000000000004','e0000000-0000-4000-8000-0000000000c8',
            '00000000-0000-4000-8000-000000000001','personal.tasks','granted',
            '00000000-0000-4000-8000-000000000004');
    inserted := true;
  EXCEPTION WHEN insufficient_privilege OR SQLSTATE '42501' THEN NULL;
  END;
  IF NOT inserted THEN
    RAISE EXCEPTION 'Unexpected: a superuser could NOT bypass RLS. The documented limitation changed.';
  END IF;
  RAISE NOTICE 'C2.4c) LIMITE DOCUMENTADO: SUPERUSER ignora RLS e pode forjar a trilha';
END
$$;

ROLLBACK;

-- 4. Tentativa direta por `nexus_app`: o papel nao tem privilegio de INSERT (barreira 1) e nao
-- tem policy de INSERT (barreira 2). Rejeitado antes de qualquer RLS.
DO $$
DECLARE
  rejected boolean := false;
  msg text;
BEGIN
  BEGIN
    SET LOCAL ROLE nexus_app;
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES ('00000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000c5',
            '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
            '00000000-0000-4000-8000-000000000004');
  EXCEPTION WHEN insufficient_privilege THEN rejected := true; msg := SQLERRM;
  END;
  RESET ROLE;
  IF NOT rejected THEN
    RAISE EXCEPTION 'nexus_app wrote the audit trail';
  END IF;
  RAISE NOTICE 'C2.4) nexus_app barrado: %', msg;
END
$$;

-- 4b. DISCRIMINACAO DA CAUSA: as recusas acima tem que vir da POLICY, nao de FK nem de falta de
-- privilegio. Provamos isso por eliminacao, restaurando a policy e comparando o erro.
DO $$
DECLARE
  owner uuid;
  other uuid := '99999999-0000-4000-8000-000000000001';
  msg_fk text;
  rejected boolean;
BEGIN
  SELECT id INTO owner FROM nexus.owner_identity WHERE singleton;

  -- (a) A FK existe e esta ativa. Tentar gravar para um owner INEXISTENTE tem que falhar — mas
  -- QUAL barreira dispara primeiro depende do papel do runner:
  --   * runner SUPERUSER: a RLS e ignorada (ver C2.4c) e quem barra e a FK -> 23503;
  --   * runner NAO-superuser sem policy de INSERT para ele: a RLS barra antes -> 42501.
  -- Aceitar as duas e o correto. Exigir 23503 sempre seria exigir um runner superusuario, que e
  -- exatamente o que a instalacao real NAO tem (R36).
  rejected := false;
  BEGIN
    INSERT INTO nexus.tool_grant_audit (owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id)
    VALUES (other, 'e0000000-0000-4000-8000-0000000000d1',
            '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted', other);
    RAISE EXCEPTION 'A non-existent owner was accepted on the audit trail';
  EXCEPTION
    WHEN foreign_key_violation THEN msg_fk := '23503 (FK)';
    WHEN SQLSTATE '42501' THEN msg_fk := '42501 (RLS)';
  END;
  IF msg_fk IS NULL THEN RAISE EXCEPTION 'A non-existent owner was accepted on the audit trail'; END IF;

  -- (b) Privilegio: `nexus_app` nao tem INSERT na tabela. Isso e uma barreira ANTERIOR e
  -- DIFERENTE da RLS — o teste C2.4 comprova que ela dispara antes.
  IF has_table_privilege('nexus_app','nexus.tool_grant_audit','INSERT') THEN
    RAISE EXCEPTION 'nexus_app unexpectedly holds INSERT on the audit trail';
  END IF;

  -- (c) RLS: o escritor TEM INSERT (privilegio garantido) e a FK satisfaz (owner real); logo a
  -- recusa so pode ser a policy.
  IF NOT has_table_privilege('nexus_audit_writer','nexus.tool_grant_audit','INSERT') THEN
    RAISE EXCEPTION 'nexus_audit_writer lacks INSERT: the RLS tests would be meaningless';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='nexus.tool_grant_audit'::regclass) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY is not enabled on the audit trail';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.oid = 'nexus.tool_grant_audit'::regclass AND p.polname = 'tool_grant_audit_writer_insert'
         AND p.polcmd = 'a'
         AND pg_get_expr(p.polwithcheck, p.polrelid) <> 'true'
     ) THEN
    RAISE EXCEPTION 'tool_grant_audit_writer_insert missing or still WITH CHECK (true)';
  END IF;

  RAISE NOTICE 'C2.4b) recusa vem da RLS: barreira efetiva foi % (FK e privilegio descartados)', msg_fk;
END
$$;

-- 5. Ausencia de privilegios de UPDATE e DELETE para nexus_app e para o escritor.
DO $$
DECLARE
  privs text;
BEGIN
  SELECT string_agg(DISTINCT privilege_type, ', ') INTO privs
  FROM information_schema.role_table_grants
  WHERE table_schema='nexus' AND table_name='tool_grant_audit'
    AND grantee IN ('nexus_app','nexus_audit_writer')
    AND privilege_type IN ('UPDATE','DELETE','TRUNCATE');
  IF privs IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected write privilege on the audit trail: %', privs;
  END IF;
  RAISE NOTICE 'C2.5) sem UPDATE/DELETE/TRUNCATE na trilha';
END
$$;

-- =============================================================================================
-- §D2. Memberships de nexus_audit_writer
-- =============================================================================================
DO $$
DECLARE
  offender text;
BEGIN
  -- Nao pode ser membro de NENHUM outro papel (nem pg_read_all_data, nem nexus_app...).
  SELECT string_agg(parent.rolname, ', ') INTO offender
  FROM pg_auth_members am
  JOIN pg_roles child ON child.oid = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
  WHERE child.rolname = 'nexus_audit_writer';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'nexus_audit_writer inherits privileges from: %', offender;
  END IF;

  -- Quem pode ser MEMBRO de nexus_audit_writer?
  --
  -- Duas categorias sao LEGITIMAS e nao configuram escalada:
  --   (a) o PROPRIO PROVISIONADOR. `ALTER FUNCTION ... OWNER TO nexus_audit_writer` exige que o
  --       executante possa SET ROLE no novo dono (verificado em PG 17.11: sem isso o erro e
  --       `must be able to SET ROLE "nexus_audit_writer"`). O provisionador precisa dessa
  --       membresia com set_option=true. Ela NAO da a ele acesso a nada que ele ja nao tenha:
  --       quem aplica migrations e dono do schema e pode criar/alterar tudo.
  --   (b) SUPERUSER/BYPASSRLS de bootstrap — fora da fronteira do RLS de qualquer forma.
  --
  -- `nexus_app` e QUALQUER OUTRO papel NAO podem. Isso e verificado abaixo, de forma explicita.
  SELECT string_agg(DISTINCT member.rolname, ', ') INTO offender
  FROM pg_auth_members am
  JOIN pg_roles member ON member.oid = am.member
  JOIN pg_roles parent ON parent.oid = am.roleid
  WHERE parent.rolname = 'nexus_audit_writer'
    AND member.rolname <> 'postgres'
    AND member.rolname <> current_user
    AND NOT member.rolsuper;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected member(s) of nexus_audit_writer: %', offender;
  END IF;

  -- O provisionador (`current_user`) pode ser membro. A membresia que o habilita a fazer o
  -- `ALTER FUNCTION ... OWNER TO` e a de `set_option = true`; ela e suficiente e nao permite
  -- delegar o papel a terceiros.
  --
  -- A membresia com `admin_option = true` tambem existe, e sua origem e o proprio `CREATE ROLE`
  -- do PostgreSQL 16+: ao criar um papel, o criador recebe automaticamente membership com
  -- `admin_option = true`, `set_option = false` e `grantor` = quem executou o CREATE ROLE. Nao e
  -- algo que esteja sob controle do schema, e NAO e escalada pratica: o unico exercicio possivel
  -- e o proprio provisionador conceder `nexus_audit_writer` a alguem — e ele ja e dono do schema,
  -- ou seja, ja pode criar qualquer objeto e ler qualquer tabela. O que importa para a seguranca
  -- e que `nexus_app` NUNCA esteja nessa lista, o que e verificado abaixo e em §E.
  --
  -- Registramos a situacao em vez de falhar, para que um endurecimento futuro (criar o papel com
  -- um papel dedicado que nao seja o de migrations) seja uma decisao consciente e visivel.
  IF EXISTS (
       SELECT 1 FROM pg_auth_members am
       JOIN pg_roles member ON member.oid = am.member
       JOIN pg_roles parent ON parent.oid = am.roleid
       WHERE parent.rolname = 'nexus_audit_writer'
         AND member.rolname = current_user
         AND am.admin_option
     ) THEN
    RAISE NOTICE 'D2 nota: o provisionador tem ADMIN OPTION (membership automatica do CREATE ROLE); nao e escalada porque ele ja e dono do schema';
  END IF;

  -- E as funcoes de checagem confirmam a ausencia de escalada.
  IF pg_has_role('nexus_app', 'nexus_audit_writer', 'MEMBER') THEN
    RAISE EXCEPTION 'nexus_app can assume nexus_audit_writer';
  END IF;
  IF pg_has_role('nexus_audit_writer', 'nexus_app', 'MEMBER') THEN
    RAISE EXCEPTION 'nexus_audit_writer inherits nexus_app';
  END IF;
  IF pg_has_role('nexus_audit_writer', 'pg_read_all_data', 'MEMBER') THEN
    RAISE EXCEPTION 'nexus_audit_writer is a member of pg_read_all_data';
  END IF;

  RAISE NOTICE 'D2) nexus_audit_writer sem membros inesperados (so o provisionador, por necessidade) e inassumivel por nexus_app';
END
$$;

-- =============================================================================================
-- §E. A aplicacao NAO escreve a trilha nem usa os enums sem permissao indevida
-- =============================================================================================
DO $$
DECLARE
  privs text;
BEGIN
  SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type) INTO privs
  FROM information_schema.role_table_grants
  WHERE grantee = 'nexus_app' AND table_schema = 'nexus' AND table_name = 'tool_grant_audit';
  IF privs IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION 'nexus_app must have exactly SELECT on the audit trail, found %', coalesce(privs, '<none>');
  END IF;

  IF has_function_privilege('nexus_app', 'nexus.audit_tool_grant_change()', 'EXECUTE') THEN
    RAISE EXCEPTION 'nexus_app can execute the audit definer function';
  END IF;

  RAISE NOTICE 'nexus_app keeps SELECT-only on the audit trail and cannot execute the definer';
END
$$;

DO $$
BEGIN
  RAISE NOTICE 'Phase 5 (G13) lifecycle, audit and ACL verification passed';
END
$$;
