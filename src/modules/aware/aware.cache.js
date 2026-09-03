/**
 * Caché TTL en memoria para las consultas a Aware. El panel se consulta "en
 * vivo" pero varios usuarios pegando cada 60 s no deben golpear la BD de
 * producción de Aware una y otra vez.
 */

const store = new Map(); // key -> { value, exp }

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.value;

  const value = await fn();
  store.set(key, { value, exp: now + ttlMs });

  // limpieza barata: si el mapa crece mucho, purgar lo vencido
  if (store.size > 200) {
    for (const [k, v] of store) if (v.exp <= now) store.delete(k);
  }
  return value;
}

export function clearAwareCache() {
  store.clear();
}
