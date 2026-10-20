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

  // Se guarda la PROMESA (no el valor ya resuelto) y se guarda ANTES de
  // esperarla — así, varias llamadas concurrentes con la misma key (típico
  // al abrir una pestaña: ~10 endpoints piden el mismo rango casi al mismo
  // tiempo) comparten el mismo fetch en vez de disparar uno cada una.
  // Si falla, se saca de la caché para que la próxima llamada reintente
  // (un error no debe quedar "cacheado").
  const promise = (async () => {
    try {
      return await fn();
    } catch (err) {
      store.delete(key);
      throw err;
    }
  })();
  store.set(key, { value: promise, exp: now + ttlMs });

  // limpieza barata: si el mapa crece mucho, purgar lo vencido
  if (store.size > 200) {
    for (const [k, v] of store) if (v.exp <= now) store.delete(k);
  }
  return promise;
}

export function clearAwareCache() {
  store.clear();
}
