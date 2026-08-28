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
  values: Array<{ label: string; value: string | null | undefined }>,
): { skippedTooShort: string[]; registered: number } {
  let changed = false;
  const skippedTooShort: string[] = [];
  let registered = 0;
  for (const entry of values) {
    const value = entry.value;
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.length < MIN_SECRET_LENGTH) {
      skippedTooShort.push(entry.label);
      continue;
    }
    if (!knownSecretValues.has(value)) {
      knownSecretValues.add(value);
      changed = true;
      registered += 1;
    }
  }
  if (changed) {
    sortedSecretValues = [...knownSecretValues].sort(
      (left, right) => right.length - left.length,
    );
  }
  return { skippedTooShort, registered };
}

/** Test-scoped: clears registered secrets so unit tests cannot leak into each other. */
export function __resetSecretRegistryForTests(): void {
  knownSecretValues.clear();
  sortedSecretValues = [];
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
