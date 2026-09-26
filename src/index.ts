interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * One call, one paper: everything openly available around it — full text, license, datasets, code, and citations.
 *
 * `research_chain({doi | pmid | arxiv_id})` walks the join that Crossref /
 * OpenAlex / Unpaywall / DataCite / Zenodo / Semantic Scholar / PubMed
 * Central each expose piecemeal:
 *
 *   paper (Crossref + OpenAlex)
 *     -> open copies, each with its OWN license + version (Unpaywall, PMC)
 *     -> datasets that cite it (DataCite relatedIdentifiers)
 *     -> code / materials that implement it (Zenodo, Hugging Face Papers)
 *     -> papers that cite it (Semantic Scholar)
 *     -> retraction status (derived from the same Crossref record)
 *
 * Every leg is independent and individually skippable — a slow or dead
 * upstream drops into `sources_failed` with a reason, never into a wrong
 * answer. An EMPTY result from an upstream (e.g. Hugging Face Papers has no
 * match) is reported as `found: false`, never silently treated as "no code
 * exists" — see docs/research-chain-scope.md and docs/silent-zero-policy.md.
 *
 * NEVER collapse `is_oa` into "reusable": `license` is returned per copy,
 * `null` when the upstream doesn't state one. "Free to read" and "permitted
 * to reuse" are different questions, and only the second one is `license`.
 *
 * Keyless throughout — every upstream here is a public, unauthenticated API.
 * Crossref/OpenAlex/Unpaywall ask only for a polite-pool contact email, which
 * we supply as our own (same pattern as the crossref/openalex/unpaywall packs).
 */


const UA = 'pipeworx-mcp-research-chain/1.0 (+https://pipeworx.io; mailto:hello@pipeworx.io)';
const CONTACT_EMAIL = 'hello@pipeworx.io';

// Every leg gets its own bounded fetch. Legs run in PARALLEL (Promise.all), so
// the wall-clock cost of the whole call is the SLOWEST leg, not the sum — a
// 10s per-leg cap keeps the total comfortably inside the 28s CF Worker budget
// even if one upstream degrades. Mirrors the epoFetch / entity_profile pattern
// (fleet #685, #1195).
const LEG_TIMEOUT_MS = 10_000;

async function pwFetch(url: string | URL, label: string, init?: RequestInit, timeoutMs = LEG_TIMEOUT_MS): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, label, timeoutMs);
}

// ── Identifier resolution ────────────────────────────────────────────────

function cleanDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim();
}

interface Resolved {
  doi: string;
  via: 'doi' | 'pmid' | 'arxiv_id';
  note?: string;
}

async function resolveIdentifier(args: Record<string, unknown>): Promise<Resolved> {
  const doi = typeof args.doi === 'string' ? args.doi.trim() : '';
  const pmid = typeof args.pmid === 'string' ? args.pmid.trim() : typeof args.pmid === 'number' ? String(args.pmid) : '';
  const arxivId = typeof args.arxiv_id === 'string' ? args.arxiv_id.trim().replace(/^arxiv:/i, '') : '';

  if (doi) return { doi: cleanDoi(doi), via: 'doi' };

  if (pmid) {
    const digits = pmid.replace(/[^0-9]/g, '');
    if (!digits) throw new Error(`Invalid pmid "${pmid}" — expected digits only, e.g. "32015507".`);
    // NCBI moved this API from www.ncbi.nlm.nih.gov/pmc/utils/idconv to
    // pmc.ncbi.nlm.nih.gov/tools/idconv (verified live 2026-09-07 — the old host
    // 301s there). Hitting the new host directly avoids a redirect round-trip.
    const url = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${digits}&idtype=pmid&format=json&tool=pipeworx&email=${encodeURIComponent(CONTACT_EMAIL)}`;
    const res = await pwFetch(url, 'NCBI ID Converter');
    if (!res.ok) throw new Error(`Could not resolve pmid ${digits} to a DOI: NCBI ID Converter returned ${res.status}.`);
    const body = (await res.json()) as { records?: Array<{ doi?: string; status?: string }> };
    const rec = body.records?.[0];
    if (!rec?.doi) throw new Error(`pmid ${digits} has no DOI on record (NCBI ID Converter${rec?.status ? `: ${rec.status}` : ''}). research_chain requires a DOI-bearing identifier.`);
    return { doi: cleanDoi(rec.doi), via: 'pmid', note: `Resolved from pmid ${digits} via NCBI ID Converter.` };
  }

  if (arxivId) {
    // arXiv auto-registers a DataCite DOI of the form 10.48550/arXiv.<id> for
    // essentially every submission since 2022 (older papers may not have one —
    // this is a best-effort construction, not a guaranteed lookup).
    const constructed = `10.48550/arxiv.${arxivId}`;
    return { doi: constructed, via: 'arxiv_id', note: `Constructed as arXiv's DataCite DOI (10.48550/arXiv.${arxivId}) — not verified to exist; downstream legs will report not_found if it doesn't.` };
  }

  throw new Error('Provide one of: doi (e.g. "10.1038/s41586-020-2649-2"), pmid (e.g. "32015507"), or arxiv_id (e.g. "2312.00752").');
}

// ── Leg bookkeeping ──────────────────────────────────────────────────────

interface Failure {
  source: string;
  reason: string;
}

async function leg<T>(name: string, used: string[], failed: Failure[], fn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await fn();
    used.push(name);
    return result;
  } catch (e) {
    failed.push({ source: name, reason: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

// ── Leg 1: the paper (Crossref + OpenAlex) ───────────────────────────────

interface CrossrefWork {
  DOI: string;
  title?: string[];
  'container-title'?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  published?: { 'date-parts'?: number[][] };
  type?: string;
  publisher?: string;
  license?: Array<{ URL?: string; 'content-version'?: string; start?: { 'date-parts'?: number[][] } }>;
  relation?: Record<string, Array<{ 'id-type'?: string; id?: string }>>;
  'is-referenced-by-count'?: number;
  'update-to'?: Array<{ DOI?: string; type?: string; label?: string }>;
}

function formatDate(d?: { 'date-parts'?: number[][] }): string | null {
  const parts = d?.['date-parts']?.[0];
  return parts ? parts.filter((p) => p != null).join('-') : null;
}

async function fetchCrossref(doi: string): Promise<CrossrefWork> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  const res = await pwFetch(url, 'Crossref');
  if (res.status === 404) throw new Error(`Crossref: no record for DOI ${doi}.`);
  if (!res.ok) throw await httpError(res, 'Crossref');
  const body = (await res.json()) as { message: CrossrefWork };
  return body.message;
}

interface OpenAlexWork {
  id: string;
  cited_by_count?: number;
  concepts?: Array<{ display_name: string }>;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  primary_location?: { source?: { display_name?: string | null } | null } | null;
}

async function fetchOpenAlex(doi: string): Promise<OpenAlexWork> {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  const res = await pwFetch(url, 'OpenAlex');
  if (res.status === 404) throw new Error(`OpenAlex: no record for DOI ${doi}.`);
  if (!res.ok) throw await httpError(res, 'OpenAlex');
  return (await res.json()) as OpenAlexWork;
}

// ── Leg 2: open copies (Unpaywall + PMC) ─────────────────────────────────

interface OaLocation {
  url?: string;
  url_for_pdf?: string;
  host_type?: string;
  version?: string;
  license?: string;
  is_best?: boolean;
  repository_institution?: string;
}

interface OaRecord {
  is_oa?: boolean;
  oa_status?: string;
  best_oa_location?: OaLocation | null;
  oa_locations?: OaLocation[];
}

interface OpenCopy {
  source: string;
  url: string | null;
  pdf_url: string | null;
  host_type: string | null;
  version: string | null; // publishedVersion | acceptedVersion | submittedVersion | null
  license: string | null; // NEVER inferred from is_oa — null when the upstream doesn't state one
  repository: string | null;
  is_best: boolean;
}

function mapLocation(loc: OaLocation): OpenCopy {
  return {
    source: 'unpaywall',
    url: loc.url ?? null,
    pdf_url: loc.url_for_pdf ?? null,
    host_type: loc.host_type ?? null,
    version: loc.version ?? null,
    license: loc.license ?? null,
    repository: loc.repository_institution ?? null,
    is_best: !!loc.is_best,
  };
}

async function fetchUnpaywall(doi: string): Promise<{ is_oa: boolean; oa_status: string | null; open_copies: OpenCopy[] }> {
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(CONTACT_EMAIL)}`;
  const res = await pwFetch(url, 'Unpaywall');
  if (res.status === 404) throw new Error(`Unpaywall: no record for DOI ${doi}.`);
  if (res.status === 422) throw new Error(`Unpaywall: invalid DOI ${doi} (HTTP 422).`);
  if (!res.ok) throw await httpError(res, 'Unpaywall');
  const rec = (await res.json()) as OaRecord;
  const locations = rec.oa_locations && rec.oa_locations.length > 0 ? rec.oa_locations : rec.best_oa_location ? [rec.best_oa_location] : [];
  return {
    is_oa: !!rec.is_oa,
    oa_status: rec.oa_status ?? null,
    open_copies: locations.map(mapLocation),
  };
}

interface PmcAvailability {
  has_full_text: boolean;
  pmcid: string | null;
  pmid: string | null;
  url: string | null;
}

async function fetchPmcAvailability(doi: string): Promise<PmcAvailability> {
  const url = `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${encodeURIComponent(doi)}&idtype=doi&format=json&tool=pipeworx&email=${encodeURIComponent(CONTACT_EMAIL)}`;
  const res = await pwFetch(url, 'NCBI ID Converter (PMC)');
  if (!res.ok) throw await httpError(res, 'NCBI ID Converter');
  // NCBI returns `pmid` as a JSON number, not a string — coerce defensively.
  const body = (await res.json()) as { records?: Array<{ pmcid?: string; pmid?: string | number; live?: boolean; status?: string }> };
  const rec = body.records?.[0];
  const pmcid = rec?.pmcid && rec.status !== 'error' ? rec.pmcid : null;
  return {
    has_full_text: !!pmcid,
    pmcid: pmcid ?? null,
    pmid: rec?.pmid != null ? String(rec.pmid) : null,
    url: pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : null,
  };
}

// ── Leg 3: datasets citing it (DataCite) ─────────────────────────────────

interface DataciteDataset {
  doi: string | null;
  title: string | null;
  resource_type_general: string | null;
  repository: string | null;
  publisher: string | null;
  year: number | null;
}

async function fetchDatacite(doi: string, limit: number): Promise<{ total: number; results: DataciteDataset[] }> {
  const params = new URLSearchParams({
    query: `relatedIdentifiers.relatedIdentifier:"${doi}"`,
    'page[size]': String(Math.min(1000, Math.max(1, limit))),
  });
  const url = `https://api.datacite.org/dois?${params}`;
  const res = await pwFetch(url, 'DataCite', { headers: { Accept: 'application/vnd.api+json' } });
  if (!res.ok) throw await httpError(res, 'DataCite');
  const body = (await res.json()) as {
    data?: Array<{ id?: string; attributes?: { doi?: string; titles?: Array<{ title?: string }>; types?: { resourceTypeGeneral?: string }; publisher?: string; publicationYear?: number } }>;
    meta?: { total?: number };
  };
  const results = (body.data ?? []).map((r) => {
    const a = r.attributes ?? {};
    return {
      doi: a.doi ?? r.id ?? null,
      title: a.titles?.[0]?.title ?? null,
      resource_type_general: a.types?.resourceTypeGeneral ?? null,
      repository: a.publisher ?? null,
      publisher: a.publisher ?? null,
      year: a.publicationYear ?? null,
    };
  });
  return { total: body.meta?.total ?? results.length, results };
}

// ── Leg 4: code / materials (Zenodo, Hugging Face Papers) ────────────────
//
// OSF was scoped as a third code/materials source but its public API has no
// DOI-filterable field — verified live 2026-09-07: `filter[doi]` on
// /v2/preprints/ returns HTTP 400 "Value 'doi' is not a filterable field."
// Dropped rather than shipped as a leg that always fails; Zenodo + Hugging
// Face Papers cover the "code/materials" join for now.

interface ZenodoHit {
  doi: string | null;
  title: string | null;
  type: string | null;
  url: string | null;
}

async function fetchZenodo(doi: string, limit: number): Promise<ZenodoHit[]> {
  const params = new URLSearchParams({
    // The bare field (no `metadata.` prefix) silently matches nothing — verified
    // live 2026-09-07: `related_identifiers.identifier:"<doi>"` returns total:0
    // for a DOI known to have 19 citing Zenodo records, while
    // `metadata.related_identifiers.identifier:"<doi>"` returns them.
    q: `metadata.related_identifiers.identifier:"${doi}"`,
    size: String(Math.min(100, Math.max(1, limit))),
  });
  const url = `https://zenodo.org/api/records?${params}`;
  const res = await pwFetch(url, 'Zenodo');
  if (!res.ok) throw await httpError(res, 'Zenodo');
  const body = (await res.json()) as { hits?: { hits?: Array<{ doi?: string; metadata?: { title?: string; upload_type?: string }; links?: { html?: string } }> } };
  return (body.hits?.hits ?? []).map((r) => ({
    doi: r.doi ?? null,
    title: r.metadata?.title ?? null,
    type: r.metadata?.upload_type ?? null,
    url: r.links?.html ?? null,
  }));
}

interface HfPapersResult {
  found: boolean;
  results: Array<{ arxiv_id: string | null; title: string | null; github_repo: string | null }>;
}

function ghUrl(repo?: string | null): string | null {
  if (!repo) return null;
  return /^https?:\/\//i.test(repo) ? repo : `https://github.com/${repo}`;
}

async function fetchPaperswithcode(doi: string): Promise<HfPapersResult> {
  const url = `https://huggingface.co/api/papers/search?q=${encodeURIComponent(doi)}`;
  const res = await pwFetch(url, 'Hugging Face Papers');
  if (!res.ok) throw await httpError(res, 'Hugging Face Papers');
  const items = (await res.json()) as Array<{ paper?: { id?: string; title?: string; githubRepo?: string | null }; title?: string }>;
  // An upstream that answers 200 with an empty/near-empty body is NOT a "no code
  // exists" answer — it is a miss. Treat it as not_found, never as an answer
  // (paperswithcode_search_papers returned a bare 63-byte body for a real DOI —
  // see docs/research-chain-scope.md §2 and docs/silent-zero-policy.md).
  if (!Array.isArray(items) || items.length === 0) {
    return { found: false, results: [] };
  }
  return {
    found: true,
    results: items.slice(0, 10).map((it) => ({
      arxiv_id: it.paper?.id ?? null,
      title: it.paper?.title ?? it.title ?? null,
      github_repo: ghUrl(it.paper?.githubRepo),
    })),
  };
}

// ── Leg 5: citing papers (Semantic Scholar) ──────────────────────────────

interface CitingPaper {
  title: string | null;
  year: number | null;
  authors: string[];
  citation_count: number | null;
}

async function fetchS2Count(doi: string): Promise<number | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=citationCount`;
  const res = await pwFetch(url, 'Semantic Scholar');
  if (res.status === 429) throw new Error('Semantic Scholar: rate limit (429) — the keyless pool allows ~1 req/sec.');
  if (res.status === 404) throw new Error(`Semantic Scholar: no record for DOI ${doi}.`);
  if (!res.ok) throw await httpError(res, 'Semantic Scholar');
  const body = (await res.json()) as { citationCount?: number };
  return typeof body.citationCount === 'number' ? body.citationCount : null;
}

async function fetchS2Citations(doi: string, limit: number): Promise<CitingPaper[]> {
  const params = new URLSearchParams({ fields: 'title,year,authors,citationCount', limit: String(Math.min(25, Math.max(1, limit))) });
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}/citations?${params}`;
  const res = await pwFetch(url, 'Semantic Scholar Citations');
  if (res.status === 429) throw new Error('Semantic Scholar: rate limit (429) — the keyless pool allows ~1 req/sec.');
  if (res.status === 404) throw new Error(`Semantic Scholar: no record for DOI ${doi}.`);
  if (!res.ok) throw await httpError(res, 'Semantic Scholar Citations');
  const body = (await res.json()) as { data?: Array<{ citingPaper?: { title?: string; year?: number; authors?: Array<{ name?: string }>; citationCount?: number } }> };
  return (body.data ?? [])
    .map((row) => row.citingPaper)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
    .map((p) => ({
      title: p.title ?? null,
      year: p.year ?? null,
      authors: (p.authors ?? []).map((a) => a.name).filter((n): n is string => !!n),
      citation_count: p.citationCount ?? null,
    }));
}

interface S2Result {
  count: number | null;
  top: CitingPaper[];
  partial_failure?: string; // set when one of the two sub-calls failed but the other succeeded
}

// Semantic Scholar's KEYLESS pool is ~1 req/sec, cumulative across endpoints —
// firing the count call and the citations call in the same instant (as two
// separate Promise.all legs) 429'd one of them on essentially every call
// (verified live 2026-09-07). Sequencing them with a stagger inside ONE leg
// keeps both under the limit without adding a second slow leg to the fan-out.
// Only throws (→ sources_failed) when BOTH sub-calls fail; a single sub-call
// failure is reported honestly via `partial_failure`, never silently dropped.
async function fetchS2(doi: string, limit: number): Promise<S2Result> {
  const countSettled = await Promise.allSettled([fetchS2Count(doi)]);
  await new Promise((r) => setTimeout(r, 1100));
  const citationsSettled = await Promise.allSettled([fetchS2Citations(doi, limit)]);

  const countResult = countSettled[0];
  const citationsResult = citationsSettled[0];
  const count = countResult.status === 'fulfilled' ? countResult.value : null;
  const top = citationsResult.status === 'fulfilled' ? citationsResult.value : [];

  if (countResult.status === 'rejected' && citationsResult.status === 'rejected') {
    throw citationsResult.reason;
  }

  const partial_failure =
    countResult.status === 'rejected'
      ? `citation count unavailable: ${countResult.reason instanceof Error ? countResult.reason.message : String(countResult.reason)}`
      : citationsResult.status === 'rejected'
        ? `citing-papers list unavailable: ${citationsResult.reason instanceof Error ? citationsResult.reason.message : String(citationsResult.reason)}`
        : undefined;

  return { count: count ?? (top.length > 0 ? top.length : null), top, ...(partial_failure ? { partial_failure } : {}) };
}

// ── Leg 6: retraction (derived from the Crossref record already fetched) ─

interface RetractionStatus {
  retracted: boolean;
  evidence: { title_marked_retracted: boolean; has_retraction_notice: boolean; crossref_relation: boolean };
  retraction_notice: Array<{ doi?: string; label?: string }> | null;
  note: string;
}

function deriveRetraction(work: CrossrefWork): RetractionStatus {
  const title = work.title?.[0] ?? '';
  const updateTo = (work['update-to'] ?? []).filter((u) => /retract/i.test(u.type ?? ''));
  const titleFlag = /RETRACTED|^\s*(retraction|withdrawn)\b/i.test(title);
  const relRetracted = !!work.relation?.['is-retracted-by'];
  const retracted = titleFlag || updateTo.length > 0 || relRetracted;
  return {
    retracted,
    evidence: { title_marked_retracted: titleFlag, has_retraction_notice: updateTo.length > 0, crossref_relation: relRetracted },
    retraction_notice: updateTo.length ? updateTo.map((u) => ({ doi: u.DOI, label: u.label })) : null,
    note: retracted
      ? 'Retraction is on record (Crossref).'
      : 'No retraction on record in Crossref — coverage depends on the publisher, so this is not definitive proof the paper is clean.',
  };
}

// ── Tool definition ───────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'research_chain',
    description:
      'Everything openly available around a paper, in ONE call: full text, license, datasets, code, and citations. Given a DOI, PMID, or arXiv id, walks paper (Crossref + OpenAlex) -> open copies with PER-COPY license and version (Unpaywall + PubMed Central — never collapses "free to read" into "permitted to reuse") -> datasets that cite it (DataCite relatedIdentifiers) -> code/materials that implement it (Zenodo, Hugging Face Papers) -> papers that cite it (Semantic Scholar) -> retraction status (Crossref/Retraction Watch). Use for "what datasets/code are linked to <DOI>", "is this paper retracted", "find an open copy of <DOI> and its license", "who has cited <paper>". Each leg is independently fetched — a slow/dead upstream is listed in sources_failed rather than failing the whole call.',
    inputSchema: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'DOI of the paper, e.g. "10.1038/s41586-020-2649-2" (a doi.org URL is also accepted).' },
        pmid: { type: 'string', description: 'PubMed ID, e.g. "32015507". Resolved to a DOI via NCBI\'s ID Converter.' },
        arxiv_id: { type: 'string', description: 'arXiv id, e.g. "2312.00752". Resolved to arXiv\'s own DataCite DOI (10.48550/arXiv.<id>) — best-effort for pre-2022 papers.' },
        max_datasets: { type: 'number', description: 'Max datasets to return (1-100, default 25). DataCite\'s `total` count is always returned even when truncated.' },
        max_citing: { type: 'number', description: 'Max citing papers to return (1-25, default 10).' },
      },
      required: [],
      anyOf: [{ required: ['doi'] }, { required: ['pmid'] }, { required: ['arxiv_id'] }],
    },
  },
];

// ── Dispatcher ────────────────────────────────────────────────────────────

async function researchChain(args: Record<string, unknown>): Promise<unknown> {
  const usedSources: string[] = [];
  const failedSources: Failure[] = [];

  const maxDatasets = Math.min(100, Math.max(1, Number(args.max_datasets) || 25));
  const maxCiting = Math.min(25, Math.max(1, Number(args.max_citing) || 10));

  let resolved: Resolved;
  try {
    resolved = await resolveIdentifier(args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), sources_used: [], sources_failed: [], as_of: new Date().toISOString() };
  }
  const doi = resolved.doi;

  const [crossref, openAlex, unpaywall, pmc, datacite, zenodo, paperswithcode, s2] = await Promise.all([
    leg('crossref', usedSources, failedSources, () => fetchCrossref(doi)),
    leg('openalex', usedSources, failedSources, () => fetchOpenAlex(doi)),
    leg('unpaywall', usedSources, failedSources, () => fetchUnpaywall(doi)),
    leg('pmc', usedSources, failedSources, () => fetchPmcAvailability(doi)),
    leg('datacite', usedSources, failedSources, () => fetchDatacite(doi, maxDatasets)),
    leg('zenodo', usedSources, failedSources, () => fetchZenodo(doi, 10)),
    leg('paperswithcode', usedSources, failedSources, () => fetchPaperswithcode(doi)),
    leg('semanticscholar', usedSources, failedSources, () => fetchS2(doi, maxCiting)),
  ]);

  const openCopies: OpenCopy[] = [...(unpaywall?.open_copies ?? [])];
  if (pmc?.has_full_text) {
    // A dedicated PMC entry — license/version are NOT guessed here. NCBI's ID
    // Converter confirms the copy exists but doesn't state its license or
    // manuscript version; Unpaywall's own oa_locations may separately carry a
    // `pmc.ncbi.nlm.nih.gov` entry WITH a version/license when it knows one.
    openCopies.push({
      source: 'pmc',
      url: pmc.url,
      pdf_url: null,
      host_type: 'repository',
      version: null,
      license: null,
      repository: 'PubMed Central',
      is_best: false,
    });
  }

  const paper = crossref || openAlex
    ? {
        doi,
        title: crossref?.title?.[0] ?? null,
        journal: crossref?.['container-title']?.[0] ?? null,
        publisher: crossref?.publisher ?? null,
        type: crossref?.type ?? null,
        published: formatDate(crossref?.published),
        authors: (crossref?.author ?? []).map((a) => (a.family && a.given ? `${a.given} ${a.family}` : a.name ?? a.family ?? null)).filter(Boolean),
        // License URL + the version it applies to, straight from Crossref — this
        // is the PUBLISHER's stated license for the version of record, distinct
        // from the per-copy `license` on each open_copies entry (which can be a
        // different, earlier version under a different license).
        license: (crossref?.license ?? []).map((l) => ({ url: l.URL ?? null, applies_to_version: l['content-version'] ?? null })),
        is_referenced_by_count: crossref?.['is-referenced-by-count'] ?? null,
        cited_by_count_openalex: openAlex?.cited_by_count ?? null,
        concepts: (openAlex?.concepts ?? []).slice(0, 8).map((c) => c.display_name),
        is_oa: unpaywall?.is_oa ?? openAlex?.open_access?.is_oa ?? null,
        oa_status: unpaywall?.oa_status ?? null,
      }
    : null;

  const retraction = crossref ? deriveRetraction(crossref) : null;
  if (!crossref) failedSources.push({ source: 'retraction', reason: 'Depends on the crossref leg, which failed — see sources_failed for the crossref reason.' });

  return {
    identifier: { input: { doi: args.doi ?? null, pmid: args.pmid ?? null, arxiv_id: args.arxiv_id ?? null }, resolved_doi: doi, resolved_via: resolved.via, resolution_note: resolved.note ?? null },
    paper,
    open_copies: openCopies,
    pmc_full_text: pmc,
    datasets: datacite ? { total: datacite.total, returned: datacite.results.length, results: datacite.results } : null,
    code: {
      zenodo: zenodo ?? [],
      paperswithcode: paperswithcode ?? { found: false, results: [] },
    },
    citing: {
      count: s2?.count ?? null,
      top: s2?.top ?? [],
      note: s2?.partial_failure ?? null,
    },
    retraction,
    sources_used: usedSources,
    sources_failed: failedSources,
    as_of: new Date().toISOString(),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'research_chain':
      return researchChain(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 8 } } satisfies McpToolExport;
