-- Foto de perfil: imagem pequena (o app redimensiona para 256x256 antes de
-- enviar) guardada como data URL. O limite no banco é uma segunda barreira;
-- a API já recusa qualquer coisa acima de ~90 mil caracteres.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_size;
ALTER TABLE users ADD CONSTRAINT users_avatar_size
  CHECK (avatar IS NULL OR length(avatar) <= 120000);
