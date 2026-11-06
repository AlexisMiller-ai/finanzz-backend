-- Início da contagem do "Total guardado", por usuário.
--
-- Antes a data era fixa no código (01/08/2026) e valia para todo mundo.
-- Agora cada pessoa tem a sua: NULL = desde o primeiro lançamento (o padrão
-- de quem chega), ou uma data escolhida no ajuste do total guardado.
--
-- Quem já usava o app antes de agosto mantém 01/08/2026, para o número que
-- essas pessoas já conhecem não mudar sozinho. O preenchimento roda uma vez
-- só, junto com a criação da coluna: as migrations rodam a cada deploy, e
-- repetir o UPDATE desfaria a escolha de quem mudou para "desde o início".

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'savings_start_date'
  ) THEN
    ALTER TABLE users ADD COLUMN savings_start_date DATE;
    UPDATE users SET savings_start_date = DATE '2026-08-01' WHERE created_at < DATE '2026-08-01';
  END IF;
END $$;
