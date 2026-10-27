// Fixed codex-rs/secrets/src/sanitizer.rs patterns, including Rust Unicode word
// boundaries, whitespace and scalar counting rather than JavaScript ASCII \b.
const WORD = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d]`
const OPENAI_KEY = /sk-[A-Za-z0-9]{20,}/g
const AWS_ACCESS_KEY_ID = new RegExp(`(?<!${WORD})AKIA[0-9A-Z]{16}(?!${WORD})`, 'gu')
const BEARER_TOKEN = new RegExp(String.raw`(?<!${WORD})[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+[A-Za-z0-9._~+/-]{16,}=*`, 'gu')
const SECRET_ASSIGNMENT = new RegExp(String.raw`(?<!${WORD})(api[_-]?key|token|secret|password)(?!${WORD})(\p{White_Space}*[:=]\p{White_Space}*)(["']?)[^\p{White_Space}"']{8,}`, 'giu')

const REDACTED = '[REDACTED_SECRET]'

export function redactSecrets(input) {
  return String(input)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(OPENAI_KEY, REDACTED)
    .replace(AWS_ACCESS_KEY_ID, REDACTED)
    .replace(SECRET_ASSIGNMENT, `$1$2$3${REDACTED}`)
}
