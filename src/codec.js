// Encodage réversible et URL-safe d'une URL complète en un seul segment de chemin.
// Pas de secret : sert uniquement à transporter une URL dans /p/<code>.
// La même implémentation existe côté client (client.js) — garder les deux identiques.

export function encodeUrl(url) {
  const bytes = new TextEncoder().encode(url);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeUrl(code) {
  let s = code.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
