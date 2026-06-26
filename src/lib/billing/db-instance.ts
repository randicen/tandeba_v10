/**
 * Worgena — DB instance resolver (P0 #4 billing + D3.4 multi-tenant).
 *
 * Patrón: cada función que toca DB acepta `dbInstance?: DbInstance` opcional.
 * Si está, usa ese (tests con `:memory:` o forward-compat con per-tenant
 * DB en Postgres). Si no, usa el DB global (`worgena.db`).
 *
 * Razón: tests de billing y de firm_membership usan :memory: para no
 * contaminar la DB real. Forward-compat: cuando Worgena migre a Postgres
 * con sharding por tenant, cada función recibe el adapter de la DB
 * del tenant concreto.
 */

import type Database from "better-sqlite3";
import { db as defaultWorgenaDb } from "../db.js";

/**
 * Tipo del DB instance. Type alias para no acoplar callers al driver.
 */
export type DbInstance = Database.Database;

let defaultDbInstance: DbInstance = defaultWorgenaDb;

/**
 * Setea el DB default. Usar SOLO al boot de la app o en tests
 * que necesiten re-routing del global. No usar en runtime.
 */
export function setDefaultDb(instance: DbInstance): void {
  defaultDbInstance = instance;
}

/**
 * Resuelve el DB instance. Por ahora retorna el global. Forward-compat:
 * cuando se implemente sharding per-tenant, esta función recibirá el
 * firmId y resolverá la DB del tenant concreto.
 */
export function getDb(): DbInstance {
  if (!defaultDbInstance) {
    throw new Error(
      "billing: default db not set. Call setDefaultDb() first or pass db explicitly.",
    );
  }
  return defaultDbInstance;
}
