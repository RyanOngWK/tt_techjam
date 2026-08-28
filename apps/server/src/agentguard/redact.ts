const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 8;
const knownSecretValues = new Set<string>();
let sortedSecretValues: string[] = [];

const SENSITIVE_KEY =
  /^(.*(_)?(api[_-]?key|authorization|bearer|password|secret|token|ak|sk)(_.*)?)$/i;

const SENSITIVE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-+=/]+\b/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\bARK_API_KEY\s*[=:]\s*\S+/gi,
  /\b(AK|SK)(ID|KEY)?\s*[=:]\s*[A-Za-z0-9+/=_-]{8,}\b/gi,
];

export function registerSecretValues(
  values: Array<string | null | undefined>,
): void {
  let changed = false;
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    if (!knownSecretValues.has(value)) {
      knownSecretValues.add(value);
      changed = true;
    }
  }
  if (changed) {
    sortedSecretValues = [...knownSecretValues].sort(
      (left, right) => right.length - left.length,
    );
  }
}

export function redactString(value: string): string {
  let next = value;
  for (const secret of sortedSecretValues) {
    next = next.split(secret).join(REDACTED);
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    next = next.replace(pattern, REDACTED);
  }
  return next;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry);
    }
    return result;
  }
  return value;
}

export function redactMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return redactValue(metadata) as Record<string, unknown>;
}

export function redactError(error: string | null | undefined): string | null {
  if (!error) return null;
  return redactString(error);
}
