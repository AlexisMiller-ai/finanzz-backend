-- Segurança.
--
-- 1. O Supabase publica uma API REST automática para toda tabela do schema
--    public, acessível com a chave "anon" (pensada para ser pública). As
--    tabelas estavam sem RLS e o papel anon tinha permissão total: com essa
--    chave dava para ler e apagar tudo. O app não usa essa API — conecta
--    direto como postgres, que ignora RLS —, então aqui ela é fechada:
--    RLS ligado sem nenhuma política (ninguém de fora passa) e as permissões
--    de anon/authenticated revogadas, inclusive para tabelas futuras.
--
-- 2. auth_attempts guarda tentativas de login e cadastro para limitar
--    força bruta. Precisa ficar no banco: no serverless da Vercel cada
--    requisição pode cair numa instância diferente, então um contador em
--    memória não segura nada.
--
-- 3. password_changed_at invalida as sessões abertas quando a senha muda.

CREATE TABLE IF NOT EXISTS auth_attempts (
  id BIGSERIAL PRIMARY KEY,
  key VARCHAR(200) NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_key_time ON auth_attempts (key, attempted_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

DO $$
DECLARE
  tabela record;
  papel text;
BEGIN
  FOR tabela IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabela.tablename);
  END LOOP;

  -- Os papéis anon e authenticated só existem no Supabase (não no banco de teste).
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', papel);
    END IF;
  END LOOP;
END $$;
