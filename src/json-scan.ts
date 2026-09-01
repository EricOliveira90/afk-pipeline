type JsonScope = { kind: "object"; keys: Set<string> } | { kind: "array" };

/**
 * First key that appears twice in the same JSON object, or `null`.
 *
 * `JSON.parse` silently keeps the last of a repeated key, so
 * `{"verdict": "ACCEPT", "verdict": "REVISE"}` parses to a single
 * verdict and reads as a clean artifact. Two values for one field is a
 * contradiction, not a value, and every artifact that carries a decision
 * has to refuse it — so the raw bytes are scanned before the parsed
 * object is trusted. That is why the parsers on this boundary take text
 * and not an already-parsed value.
 *
 * It lives in its own module because the boundary is wider than the one
 * artifact it was written for. The contract review and the QA review used
 * it from `contract-review.ts`; the adjudication artifact, the persisted
 * decision log, the scope escalation and the acceptance manifest need
 * exactly the same guarantee (PM blocker 1, fifth adjudication gate
 * round), and none of those belongs downstream of contract review.
 *
 * Only well-formed JSON reaches this scanner — callers parse first — so
 * it does not need to validate syntax, only to walk strings correctly so
 * a `":"` inside a string value is never mistaken for a key separator.
 */
export function findDuplicateJsonKey(text: string): string | null {
  const scopes: JsonScope[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "{") {
      scopes.push({ kind: "object", keys: new Set() });
      index++;
      continue;
    }
    if (char === "[") {
      scopes.push({ kind: "array" });
      index++;
      continue;
    }
    if (char === "}" || char === "]") {
      scopes.pop();
      index++;
      continue;
    }
    if (char !== '"') {
      index++;
      continue;
    }

    const start = index;
    index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index++;
        break;
      }
      index++;
    }
    const literal = text.slice(start, index);

    // A string is a key only when the next non-whitespace character is a
    // colon and the enclosing scope is an object.
    let after = index;
    while (after < text.length && /\s/.test(text[after]!)) after++;
    const scope = scopes[scopes.length - 1];
    if (text[after] !== ":" || scope?.kind !== "object") continue;

    let key: unknown;
    try {
      key = JSON.parse(literal);
    } catch {
      continue;
    }
    if (typeof key !== "string") continue;
    if (scope.keys.has(key)) return key;
    scope.keys.add(key);
  }
  return null;
}

/**
 * `JSON.parse` for an artifact whose keys carry meaning: valid JSON with
 * no key repeated in any object, or a throw naming the defect.
 *
 * Both failures are reported in the caller's own words — `source` is the
 * artifact name the operator sees — because at this boundary "the file is
 * not parseable" and "the file says two contradictory things" are the same
 * refusal: nothing downstream may guess which value the author meant.
 */
export function parseJsonWithUniqueKeys(text: string, source: string): unknown {
  // A leading UTF-8 BOM is stripped, not refused. `adjudication.md` is
  // written by a *human*, on Windows, and PowerShell's `Set-Content` and
  // Notepad both emit one by default — after which `JSON.parse` fails with
  // "Unexpected token" at position 0 and the slice stays parked on what looks
  // like a mystery. A BOM carries no semantics, so nothing is being guessed
  // at here; the operator's decision is unambiguous and gets applied. Found
  // by the fifth round's self-probe pass, not by a gate.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const duplicate = findDuplicateJsonKey(body);
  if (duplicate !== null) {
    throw new Error(
      `${source} repeats the key "${duplicate}" in one object; a repeated ` +
        `key carries two values for one field and which one survives is a ` +
        `JSON-runtime accident, so the artifact is refused rather than ` +
        `guessed at`,
    );
  }
  return parsed;
}
