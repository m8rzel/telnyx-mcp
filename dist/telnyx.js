import { API_BASE, redact } from './config.js';
export class TelnyxError extends Error {
    status;
    code;
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'TelnyxError';
    }
}
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Exponential backoff with jitter, capped at 15 s. */
export function backoffMs(attempt, retryAfterSeconds) {
    if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
        return Math.min(Math.max(retryAfterSeconds, 0) * 1000, 30_000);
    }
    const base = Math.min(2 ** (attempt - 1) * 500, 15_000);
    return base + Math.floor(Math.random() * 250);
}
function parseRetryAfter(header) {
    if (!header)
        return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds))
        return seconds;
    const date = Date.parse(header);
    if (Number.isFinite(date))
        return Math.max((date - Date.now()) / 1000, 0);
    return undefined;
}
/** Extracts Telnyx's `errors` array into a single readable line. */
export function describeTelnyxError(body) {
    try {
        const parsed = JSON.parse(body);
        const errors = parsed.errors;
        if (Array.isArray(errors) && errors.length > 0) {
            const parts = errors.map((entry) => {
                const e = entry;
                return [e.code ? `[${e.code}]` : null, e.title, e.detail].filter(Boolean).join(' ');
            });
            const first = errors[0];
            return { message: parts.join('; '), code: first.code };
        }
    }
    catch {
        // not JSON — fall through to the raw body
    }
    return { message: body.slice(0, 2000) };
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Thin Telnyx REST client: bearer auth from config, timeout per attempt,
 * retry with backoff on 429/5xx and network errors. The API key is only ever
 * placed in the Authorization header and is scrubbed from every error message.
 */
export class TelnyxClient {
    config;
    fetchImpl;
    sleep;
    constructor(config, deps = {}) {
        this.config = config;
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
        this.sleep = deps.sleep ?? defaultSleep;
    }
    headers(accept) {
        return {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: accept,
            'Content-Type': 'application/json',
            'User-Agent': 'telnyx-mcp/1.0',
        };
    }
    async request(pathname, init, options = {}) {
        const maxRetries = options.maxRetries ?? this.config.maxRetries;
        const url = `${API_BASE}${pathname}`;
        let lastError = null;
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
            const timeout = AbortSignal.timeout(this.config.timeoutMs);
            const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
            let response;
            try {
                response = await this.fetchImpl(url, {
                    method: init.method,
                    headers: this.headers(init.accept),
                    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                    signal,
                });
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                lastError = new TelnyxError(`Network error calling ${pathname} (attempt ${attempt}/${maxRetries}): ${redact(reason, this.config.apiKey)}`);
                if (attempt < maxRetries) {
                    await this.sleep(backoffMs(attempt));
                    continue;
                }
                throw lastError;
            }
            if (response.ok)
                return response;
            const body = await response.text().catch(() => '');
            const { message, code } = describeTelnyxError(body);
            lastError = new TelnyxError(`Telnyx API ${response.status} on ${pathname}: ${redact(message, this.config.apiKey)}`, response.status, code);
            if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
                await this.sleep(backoffMs(attempt, parseRetryAfter(response.headers.get('retry-after'))));
                continue;
            }
            throw lastError;
        }
        throw lastError ?? new TelnyxError(`Request to ${pathname} failed.`);
    }
    async getJson(pathname, options) {
        const response = await this.request(pathname, { method: 'GET', accept: 'application/json' }, options);
        return (await response.json());
    }
    async postBinary(pathname, body, options) {
        const response = await this.request(pathname, { method: 'POST', body, accept: 'audio/mpeg' }, options);
        const data = Buffer.from(await response.arrayBuffer());
        return {
            data,
            contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        };
    }
}
