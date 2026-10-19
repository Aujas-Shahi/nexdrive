/**
 * Base URL of the API.
 *
 * In local development the API runs on its own port, set by `VITE_SERVER_URL`.
 * In production the web host proxies `/api` and `/trpc` to the API, so the API
 * lives at the page's own origin and the auth cookie stays first-party.
 */
export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");
