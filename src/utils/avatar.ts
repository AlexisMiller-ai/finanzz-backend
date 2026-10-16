/** Maior data URL aceita (~66 KB de imagem). Cabe no limite de 100 KB do corpo JSON. */
export const AVATAR_MAX_LENGTH = 90_000;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Confere a assinatura dos primeiros bytes contra o tipo declarado. */
function matchesSignature(type: string, bytes: Buffer): boolean {
  if (type === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (type === "webp") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

/**
 * Valida a foto de perfil enviada como data URL. Só aceita JPEG, PNG ou WebP
 * cujo conteúdo realmente seja do tipo declarado — um "data:image/png" com
 * HTML dentro, por exemplo, é recusado.
 */
export function validateAvatar(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !value) {
    return { ok: false, message: "Envie a imagem da foto" };
  }
  if (value.length > AVATAR_MAX_LENGTH) {
    return { ok: false, message: "A imagem é grande demais" };
  }

  const match = value.match(DATA_URL);
  if (!match) {
    return { ok: false, message: "Use uma imagem JPG, PNG ou WebP" };
  }

  const [, type, base64] = match;
  const bytes = Buffer.from(base64!, "base64");
  if (bytes.length < 12 || !matchesSignature(type!, bytes)) {
    return { ok: false, message: "O arquivo não parece ser uma imagem válida" };
  }

  return { ok: true, value };
}
