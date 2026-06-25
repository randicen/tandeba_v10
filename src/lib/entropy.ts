/**
 * Worgena — Shannon entropy utility (Backlog P0 #1).
 *
 * Calcula la entropía de Shannon de un string: H = -Σ(p_i * log2(p_i))
 * donde p_i es la frecuencia relativa de cada caracter.
 *
 * **Uso**: detectar strings de alta entropía que probablemente son
 * secrets random (API keys, JWTs, hashes). Un texto natural tiene
 * entropy ~3.5-4.5; un secret random tiene 4.5+.
 *
 * **Forward-compat**: si necesitamos algoritmos más sofisticados
 * (e.g., gzip ratio), los agregamos acá.
 */

/**
 * Calcula Shannon entropy de un string en bits/char.
 * Retorna 0 si el string está vacío.
 */
export function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const ch of input) {
    frequencies.set(ch, (frequencies.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = input.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}