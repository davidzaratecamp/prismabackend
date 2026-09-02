import { env } from '../../config/env.js';

/**
 * Cliente REST mínimo para la API de Retell AI.
 * Usa el `fetch` global de Node ≥18. Docs: https://docs.retellai.com/api-references/
 *
 * Autenticación: header  Authorization: Bearer <API_KEY>
 * Base URL:      https://api.retellai.com
 *
 * NOTA DE VERSIONES: la doc de Retell mezcla rutas versionadas y sin versión
 * (list-calls también existe como /v3). Si algo devuelve 404, ajustar ENDPOINTS.
 */

const ENDPOINTS = {
  listAgents: '/list-agents',
  getAgent: (id) => `/get-agent/${encodeURIComponent(id)}`,
  listPhoneNumbers: '/list-phone-numbers',
  getPhoneNumber: (n) => `/get-phone-number/${encodeURIComponent(n)}`,
  getConcurrency: '/get-concurrency',
  listKnowledgeBases: '/list-knowledge-bases',
  listCalls: '/v2/list-calls',
  getCall: (id) => `/v2/get-call/${encodeURIComponent(id)}`,
};

export class RetellApiError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.name = 'RetellApiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

/** ¿Hay API key configurada? */
export function isRetellConfigured() {
  return Boolean(env.retell.apiKey);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) =>
  Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);

export class RetellClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || env.retell.apiKey;
    this.baseUrl = (opts.baseUrl || env.retell.baseUrl).replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.minRequestGapMs = opts.minRequestGapMs ?? 120;
    this._lastRequestAt = 0;
    if (!this.apiKey) {
      throw new Error('RetellClient: falta RETELL_API_KEY en el backend.');
    }
  }

  async _request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const gap = Date.now() - this._lastRequestAt;
    if (gap < this.minRequestGapMs) await sleep(this.minRequestGapMs - gap);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt <= this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new RetellApiError(`Error de red llamando ${method} ${path}: ${err.message}`, {
          endpoint: path,
        });
      }
      clearTimeout(timer);
      this._lastRequestAt = Date.now();

      if ((res.status === 429 || res.status >= 500) && attempt <= this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        await sleep(waitMs);
        continue;
      }

      const text = await res.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }

      if (!res.ok) {
        throw new RetellApiError(`Retell ${method} ${path} respondió ${res.status}`, {
          status: res.status,
          body: payload,
          endpoint: path,
        });
      }
      return payload;
    }
  }

  listAgents() {
    return this._request('GET', ENDPOINTS.listAgents);
  }

  getAgent(agentId, version) {
    return this._request('GET', ENDPOINTS.getAgent(agentId), {
      query: version != null ? { version } : undefined,
    });
  }

  listPhoneNumbers() {
    return this._request('GET', ENDPOINTS.listPhoneNumbers);
  }

  getPhoneNumber(phoneNumber) {
    return this._request('GET', ENDPOINTS.getPhoneNumber(phoneNumber));
  }

  getConcurrency() {
    return this._request('GET', ENDPOINTS.getConcurrency);
  }

  getCall(callId) {
    return this._request('GET', ENDPOINTS.getCall(callId));
  }

  /**
   * POST /v2/list-calls
   * @param {object} p
   * @param {object} [p.filterCriteria]
   * @param {'ascending'|'descending'} [p.sortOrder='descending']
   * @param {number} [p.limit=500]
   * @param {string} [p.paginationKey]
   */
  listCalls({ filterCriteria, sortOrder = 'descending', limit = 500, paginationKey } = {}) {
    const body = {};
    if (filterCriteria && Object.keys(filterCriteria).length) body.filter_criteria = filterCriteria;
    if (sortOrder) body.sort_order = sortOrder;
    if (limit) body.limit = limit;
    if (paginationKey) body.pagination_key = paginationKey;
    return this._request('POST', ENDPOINTS.listCalls, { body });
  }

  /**
   * Itera todas las llamadas que matcheen el filtro, paginando.
   * Soporta respuesta como array plano (v2) o { items, pagination_key } (v3).
   */
  async *iterateCalls({
    filterCriteria,
    sortOrder = 'descending',
    pageSize = 500,
    maxPages = Infinity,
  } = {}) {
    let paginationKey;
    let page = 0;
    const seen = new Set();
    while (page < maxPages) {
      const res = await this.listCalls({ filterCriteria, sortOrder, limit: pageSize, paginationKey });
      const items = Array.isArray(res) ? res : res?.items || res?.calls || [];
      if (!items.length) return;

      for (const it of items) {
        if (it?.call_id && seen.has(it.call_id)) continue;
        if (it?.call_id) seen.add(it.call_id);
        yield it;
      }

      page += 1;
      const hasMore = Array.isArray(res) ? items.length === pageSize : Boolean(res?.has_more);
      if (!hasMore) return;

      const last = items[items.length - 1];
      paginationKey = (res && res.pagination_key) || (last && last.call_id);
      if (!paginationKey) return;
    }
  }
}

export { ENDPOINTS };
