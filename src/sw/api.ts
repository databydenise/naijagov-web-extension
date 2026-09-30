import type { PageContext, Plan } from "@/shared/plan";
import { TOKEN_KEY } from "@/shared/state";
import type { RunOutcome } from "@/shared/results";
import type { WireContextRequest, WirePlanRequest, WireResultsRequest } from "@/sw/payload";
import { parseErrorBody, parsePageContext, parsePlan, parseRunHint, unwrapEnvelope } from "@/sw/wire";

/**
 * The backend client, and the only file in this repo that calls `fetch`.
 *
 * Everything the extension knows that it did not read off the page comes from
 * here: every explanation, every plan, every government rule. None of it is
 * decided in the browser. ESLint enforces the "only file" part — see
 * `no-restricted-globals` in `eslint.config.js`.
 */

const DEFAULT_BASE = "https://naija-gov-repository-backend-lsvyjcrea-denise25.vercel.app";

/** No hardcoded hosts. `.env` sets this; the default is the local backend. */
const API_BASE = (import.meta.env.VITE_API_BASE ?? DEFAULT_BASE).replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  /** 0 when the request never reached a server. */
  readonly status: number;
  readonly path: string;
  /**
   * The backend's own code, when it sent one.
   *
   * `UNAUTHENTICATED`, `PAGE_CHANGED`, `MODEL_TIMEOUT` and the rest, from `ErrorCode`
   * in their `src/constants.py`. The panel branches on this; absent means the failure
   * happened below the level where they could name it.
   */
  readonly code?: string;
  /** Seconds. Only a 429 carries one. */
  readonly retryAfter?: number;

  constructor(
    status: number,
    path: string,
    message: string,
    extra: { code?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
  }

  /** The backend is there but does not accept our token. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Nothing answered. Usually the backend simply is not running. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

/**
 * Is this install connected to an account?
 *
 * Asked by the worker before it acts on anything it reads from a page: an
 * unconnected install has nothing to plan with and stays `IDLE`.
 */
export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== undefined;
}

/**
 * The extension token, created by the user on the web app and pasted into the
 * connect screen.
 *
 * `chrome.storage.local` is not encrypted. It holds the token and a profile
 * cache and nothing more sensitive than that, and the connect screen says so.
 */
async function getToken(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export interface ApiFetchOptions {
  method?: "GET" | "POST";
  /** Serialized as JSON. Never contains a value read off the page. */
  body?: unknown;
  signal?: AbortSignal;
}

async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { method = "GET", body, signal } = options;

  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");

  const token = await getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Deliberately not the underlying message: it varies by platform and can
    // carry the URL into a UI string.
    throw new ApiError(0, path, "Could not reach the server.");
  }

  if (!response.ok) throw await failure(response, path);

  // Every JSON body is wrapped by the backend's response middleware. Unwrapped here,
  // once, so each endpoint's parser sees the shape its Python model declares.
  return unwrapEnvelope(await response.json()) as T;
}

/**
 * A non-2xx, as an error carrying what the backend actually said.
 *
 * Their sentences are written for a citizen who has already lost a morning to a
 * portal, and the panel prints them verbatim rather than inventing a technical
 * explanation of its own. `The server returned 502.` is the fallback for a failure
 * that carried no envelope — a proxy, or a crash before their handler ran.
 */
async function failure(response: Response, path: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const parsed = parseErrorBody(body);

  if (!parsed) {
    return new ApiError(
      response.status,
      path,
      `The server returned ${response.status}.`,
    );
  }

  return new ApiError(response.status, path, parsed.message, {
    code: parsed.code,
    ...(parsed.retryAfter === undefined
      ? {}
      : { retryAfter: parsed.retryAfter }),
  });
}

/**
 * `GET /health`'s body, inside the envelope.
 *
 * There is no `version` field and never was — this interface previously declared one
 * along with an `ok` boolean, and neither exists. `ok` being absent made
 * `reachable: undefined`, so a perfectly healthy backend showed as "Backend offline"
 * in the status strip.
 *
 * The rest of the body (`placeholder_rules`, `retrieval`, `results`) goes null-ish when
 * the database is unreachable, which is why `status` is the only field read here: it is
 * the one that answers the only question the panel asks.
 */
export interface HealthResponse {
  status: string;
  demo_mode?: boolean;
}

/**
 * `GET /health`.
 *
 * Allowed to fail. The backend may not be running, and the panel shows that as
 * "backend offline" — a line of text, not a crash.
 */
export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health", { signal });
}

/** Whether a health body means "fine", as the strip's dot reads it. */
export function isHealthy(response: HealthResponse): boolean {
  return response.status.trim().toLowerCase() === "okay";
}

/**
 * `POST /context`. Identify the workflow and step, and open a session.
 *
 * This is what makes `/plan` possible: a plan is planned *within* a session, and
 * `session_id` cannot be obtained any other way. It also returns the server's own
 * `page_hash`, which the extension adopts — see `sw/context.ts`.
 */
export async function postContext(
  body: WireContextRequest,
  signal?: AbortSignal,
): Promise<PageContext> {
  return parsePageContext(
    await apiFetch<unknown>("/context", { method: "POST", body, signal }),
  );
}

/**
 * `POST /plan`. The one model call.
 *
 * Slow by nature — their budget is a little over twenty seconds — and the caller is
 * expected to be holding a message channel open across it, which is what keeps the
 * service worker from being stopped mid-turn.
 */
export async function postPlan(
  body: WirePlanRequest,
  signal?: AbortSignal,
): Promise<Plan> {
  return parsePlan(
    await apiFetch<unknown>("/plan", { method: "POST", body, signal }),
  );
}

/**
 * `POST /results`. What the run actually managed, and what the user does next.
 *
 * Reporting, not asking: nothing in the body requests permission for anything, and
 * the run is already over by the time this is called. The answer's only use in the
 * panel is the summary's footer sentence, which is why a failure here is allowed to
 * cost the footer its sentence and nothing else.
 */
export async function postResults(
  body: WireResultsRequest,
  signal?: AbortSignal,
): Promise<Pick<RunOutcome, "hint" | "finalStep">> {
  return parseRunHint(
    await apiFetch<unknown>("/results", { method: "POST", body, signal }),
  );
}
