// Resilience layer for fetching LEMON Manuals mirrors, split out from
// index.ts so it can be unit tested without hitting the network. See #26:
// during an upstream outage, an unbounded fetch() plus an ancestor walk that
// retried on *any* error turned one dead mirror into ~150s of hangs.

export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface FetchResult {
  html: string;
  finalUrl: string;
}

export interface DirResult extends FetchResult {
  fetchedSegs: string[];
}

function describeError(e: unknown): string {
  const cause = (e as { cause?: unknown } | undefined)?.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return String((cause as { code?: unknown }).code);
  }
  if (cause !== undefined && cause !== null) return String(cause);
  return String(e);
}

export interface ResilientFetcherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  circuitBreakerMs?: number;
}

// Fetches `target` (validated against allowedOrigins) trying each mirror
// origin in failover order. A mirror that errors at the network/transport
// level (timeout, DNS, connection refused) is remembered as "dead" for
// `circuitBreakerMs` so subsequent requests skip straight past it instead of
// re-paying its timeout. An HTTP status error (e.g. 404) is NOT failed over —
// mirrors serve identical content, so another mirror would 404 too.
export function createResilientFetcher(
  allowedOrigins: string[],
  userAgent: string,
  deps: ResilientFetcherDeps = {}
) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const circuitBreakerMs = deps.circuitBreakerMs ?? 60_000;
  const deadUntil = new Map<string, number>();

  function isDead(origin: string): boolean {
    const until = deadUntil.get(origin);
    return until !== undefined && now() < until;
  }
  function markDead(origin: string): void {
    deadUntil.set(origin, now() + circuitBreakerMs);
  }

  async function fetchUrl(target: string): Promise<FetchResult> {
    const u = new URL(target);
    if (!allowedOrigins.includes(u.origin)) {
      throw new Error(`URL origin must be one of: ${allowedOrigins.join(", ")} — got ${u.origin}`);
    }
    const ordered = [u.origin, ...allowedOrigins.filter((o) => o !== u.origin)];
    const notDead = ordered.filter((o) => !isDead(o));
    const toTry = notDead.length > 0 ? notDead : ordered;

    let lastErr: unknown;
    for (const origin of toTry) {
      const candidate = origin + u.pathname + u.search;
      try {
        const res = await fetchImpl(candidate, {
          headers: { "User-Agent": userAgent, Accept: "text/html" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          // Mirrors serve identical content — a 404 here means the path is
          // really gone, not that this particular mirror is broken.
          throw new HttpStatusError(res.status, candidate);
        }
        return { html: await res.text(), finalUrl: candidate };
      } catch (e) {
        if (e instanceof HttpStatusError) throw e;
        markDead(origin);
        lastErr = e;
      }
    }
    throw new Error(`All mirrors failed for ${u.pathname}: ${describeError(lastErr)}`);
  }

  return { fetchUrl, isDead, markDead };
}

// Some LEMON templates nest real content under plain-text category headers
// with no page of their own (#22). A path built from one of those synthetic
// headers 404s — walk up to the nearest real ancestor page and let the
// caller re-filter its links against the full requested path instead.
//
// Only a 404 justifies that walk: a network/timeout error means the mirror
// (or the whole upstream) is down, and retrying N shallower paths would just
// multiply the same timeout N times without any chance of success.
export async function fetchDirResilient(
  fetchDir: (path: string) => Promise<FetchResult>,
  path: string,
  segsOf: (path: string) => string[]
): Promise<DirResult> {
  const segs = segsOf(path);
  try {
    const { html, finalUrl } = await fetchDir(path);
    return { html, finalUrl, fetchedSegs: segs };
  } catch (err) {
    if (!(err instanceof HttpStatusError && err.status === 404)) throw err;
    for (let pop = 1; pop < segs.length; pop++) {
      const ancestorSegs = segs.slice(0, segs.length - pop);
      try {
        const { html, finalUrl } = await fetchDir(ancestorSegs.join("/"));
        return { html, finalUrl, fetchedSegs: ancestorSegs };
      } catch (ancestorErr) {
        if (!(ancestorErr instanceof HttpStatusError && ancestorErr.status === 404)) throw ancestorErr;
        // try a shallower ancestor
      }
    }
    throw err;
  }
}
