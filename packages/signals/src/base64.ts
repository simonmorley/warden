const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes standard or URL-safe base64 to a Latin-1 string, or returns null if the input
 * isn't base64. Hand-rolled because atob is a web API, and this package sees only the
 * ES standard library.
 */
export function decodeBase64(input: string): string | null {
  const normalised = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (normalised.length === 0 || normalised.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(normalised)) return null;

  let bits = 0;
  let value = 0;
  let output = "";
  for (const char of normalised) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return output;
}
