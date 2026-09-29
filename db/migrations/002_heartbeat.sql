-- Registro de atividade usado para impedir que o projeto do Supabase
-- seja pausado por inatividade (plano free pausa após 7 dias).
-- Uma linha só, atualizada pelos agendadores.

CREATE TABLE IF NOT EXISTS app_heartbeat (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_ping TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_ping TIMESTAMPTZ,
  source VARCHAR(40),
  ping_count BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT app_heartbeat_single_row CHECK (id = 1)
);

INSERT INTO app_heartbeat (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
