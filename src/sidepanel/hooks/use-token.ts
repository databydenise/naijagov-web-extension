import { useEffect, useState } from "react";
import { sendToRuntime } from "@/shared/messages";
import { TOKEN_KEY } from "@/shared/state";

/**
 * The extension token, from `chrome.storage.local`.
 *
 * That storage is not encrypted. It holds the token and a profile cache and
 * nothing more sensitive, and the connect card says so plainly rather than
 * leaving the user to assume otherwise.
 *
 * Subscribed to `onChanged` as well as read once, because a second panel — or
 * the connect card in this one — can write the token while this instance is
 * mounted, and a panel showing the connect screen next to a connected one is a
 * bug the user cannot explain.
 */

export type Loadable<T> = { status: "loading" } | { status: "ready"; value: T };

export function useToken(): Loadable<string | undefined> {
  const [token, setToken] = useState<Loadable<string | undefined>>({ status: "loading" });

  useEffect(() => {
    let live = true;

    void chrome.storage.local.get(TOKEN_KEY).then(async (stored) => {
  let existingToken = normalize(stored[TOKEN_KEY]);

  const demoToken = normalize(import.meta.env.VITE_DEMO_TOKEN);

  if (!existingToken && demoToken) {
    await chrome.storage.local.set({ [TOKEN_KEY]: demoToken });
    existingToken = demoToken;
  }

  if (live) {
    setToken({ status: "ready", value: existingToken });
  }
});

    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return token;
}

/** Write the token. The only writer in the panel, so the rest stays read-only. */
export async function storeToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token.trim() });
}

/**
 * Forget the account.
 *
 * Asks the worker rather than clearing storage here, because a disconnect has to
 * take the per-tab session state with it and that belongs to the worker — the
 * panel only ever reads it. Throws if the worker could not finish, so the caller
 * can say so instead of showing a disconnect that did not happen.
 */
export async function disconnect(): Promise<void> {
  await sendToRuntime({ type: "DISCONNECT" });
}

/** No hardcoded hosts. `.env` sets this; the default is the local web app. */
const WEB_BASE = (import.meta.env.VITE_WEB_BASE ?? "http://localhost:3000").replace(/\/$/, "");

/**
 * Open the page where a token is created.
 *
 * Here rather than in the card because getting a token and storing one are the
 * same errand, and because it keeps `chrome.*` inside `hooks/` — the connect
 * card takes a callback and stays presentational.
 */
export function openProfile(): void {
  void chrome.tabs.create({ url: `${WEB_BASE}/profile` });
}

/** An empty string is not a token. Treated as absent, so the connect card stays up. */
function normalize(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
