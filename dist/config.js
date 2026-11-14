import { tmpdir } from 'node:os';
import path from 'node:path';
export const API_BASE = 'https://api.telnyx.com/v2';
export const ENV_API_KEY = 'TELNYX_API_KEY';
export const ENV_OUTPUT_DIR = 'TELNYX_TTS_OUTPUT_DIR';
export const ENV_TIMEOUT_MS = 'TELNYX_TTS_TIMEOUT_MS';
export const ENV_MAX_RETRIES = 'TELNYX_TTS_MAX_RETRIES';
export class ConfigError extends Error {
}
function readPositiveInt(name, fallback, env) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
    }
    return value;
}
/**
 * Reads configuration from the environment. The API key is never defaulted,
 * never logged and never written anywhere — a missing key aborts startup.
 */
export function loadConfig(env = process.env) {
    const apiKey = env[ENV_API_KEY]?.trim();
    if (!apiKey) {
        throw new ConfigError(`Missing ${ENV_API_KEY}. Set it in the environment of the MCP server process ` +
            `(for example in the "env" block of your MCP client config) and restart. ` +
            `The key is read from the environment only — it is never stored in this repository.`);
    }
    const configuredDir = env[ENV_OUTPUT_DIR]?.trim();
    const outputDir = configuredDir
        ? path.resolve(configuredDir)
        : path.join(tmpdir(), 'telnyx-mcp');
    return {
        apiKey,
        outputDir,
        timeoutMs: readPositiveInt(ENV_TIMEOUT_MS, 120_000, env),
        maxRetries: readPositiveInt(ENV_MAX_RETRIES, 3, env),
    };
}
/** Removes anything that looks like a bearer token from a string before it is shown. */
export function redact(text, apiKey) {
    let out = text;
    if (apiKey && apiKey.length >= 8) {
        out = out.split(apiKey).join('[REDACTED]');
    }
    return out
        .replace(/(Bearer\s+)[A-Za-z0-9_\-.]+/gi, '$1[REDACTED]')
        .replace(/\bKEY[0-9A-Z]{10,}\b/g, '[REDACTED]');
}
