// Ported verbatim from codex-rs/secrets/src/sanitizer.rs. Codex applies this to
// every stage-1 output field, independently of what the prompt asked the model
// to do.
const OPENAI_KEY = /sk-[A-Za-z0-9]{20,}/g
const AWS_ACCESS_KEY_ID = /\bAKIA[0-9A-Z]{16}\b/g
const BEARER_TOKEN = /\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi

const REDACTED = '[REDACTED_SECRET]'

export function redactSecrets(input) {
  return String(input)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(OPENAI_KEY, REDACTED)
    .replace(AWS_ACCESS_KEY_ID, REDACTED)
    .replace(SECRET_ASSIGNMENT, `$1$2$3${REDACTED}`)
}
