import {
  createJobQueue,
  createRunStore,
  createSqliteStore,
  defaultDbPath,
  migrate,
  openDb,
  createDefaultRetriever,
} from "@triage/data";
import { createDefaultRouter, loadDotEnv } from "@triage/providers";
import { assertSecret } from "./auth.ts";

/** What both processes (the API and the worker) share: the database, the stores and the settings. */
export function openRuntime() {
  const env = { ...loadDotEnv(), ...process.env };
  const db = openDb(defaultDbPath());
  migrate(db);
  const store = createSqliteStore(db);
  return {
    env,
    store,
    runs: createRunStore(db),
    queue: createJobQueue(db),
    jwtSecret: assertSecret(env.JWT_SECRET),
    /** A pinned date for demos and tests; unset means today in India. */
    pinnedToday: env.TRIAGE_TODAY,
    retriever: () => createDefaultRetriever(store),
    router: () => createDefaultRouter(),
  };
}

export const todayInIndia = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
