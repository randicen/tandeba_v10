/**
 * Worgena — Better Auth instance (D3.4).
 *
 * Capa 2 de la arquitectura de 4 capas (ver design spec §3):
 * - Capa 1: SQLite (worgena.db, compartido con el motor)
 * - Capa 2: este archivo (Better Auth como librería, no servicio)
 * - Capa 3: server.ts middleware (helmet + rate limit + authMiddleware)
 * - Capa 4: Frontend (React/Vite, login.html)
 *
 * Decisiones clave (ver AGENT_D3_4_5_DB_AUTH_SPEC.md §2):
 * - Better Auth 1.6 como librería, no servicio externo (lock-in bajo).
 * - Misma SQLite worgena.db con prefijo `auth_*` para evitar colisión
 *   con las tablas del motor (paused_tasks, workflow_audit) y D1
 *   (sessions, spaces, etc.).
 * - Google OAuth ONLY en D3.4 (no password, no magic link). Razón:
 *   cubre el 95% del mercado colombiano, sin passwords = sin vector
 *   de credential stuffing.
 * - `default_tenant_id` como additionalField en auth_user. Es la columna
 *   que DbAuthProvider lee para dar el tenantId al motor.
 *
 * Forward-compat:
 * - Si migramos a Postgres en D4, solo cambiamos `database: db` por
 *   `database: new Pool({ ... })`. El resto del código no se entera.
 * - Si queremos añadir magic links / password / SAML en D3.6+,
 *   se agregan como providers. Cero cambio al motor.
 */

import { betterAuth } from "better-auth";
import { db } from "../db.js";

/**
 * URL base de la app. Better Auth la usa para construir el callback URL
 * de Google OAuth. Si está mal configurada, Google retorna
 * `redirect_uri_mismatch` y el login falla.
 *
 * En dev: http://localhost:3000
 * En prod (Railway): https://*.railway.app
 */
const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/**
 * Secret usado por Better Auth para firmar cookies y CSRF tokens.
 * DEBE ser >= 32 caracteres con alta entropía.
 *
 * Generar con: openssl rand -base64 32
 *
 * Si falta, Better Auth rechaza arrancar. Esto es fail-loud (no fallback).
 */
const SECRET = process.env.BETTER_AUTH_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error(
    "BETTER_AUTH_SECRET is required and must be >= 32 chars. " +
      "Generate with: openssl rand -base64 32",
  );
}

/**
 * Better Auth instance.
 *
 * Configuración:
 * - `database`: reutilizamos la misma instancia de `db` de src/lib/db.ts.
 *   Better Auth abre sus propias prepared statements; no choca con las
 *   del motor porque usa prefijo `auth_*`.
 * - `user.modelName: "auth_user"`: prefijo para evitar colisión.
 * - `user.additionalFields.default_tenant_id`: columna custom que
 *   identifica el tenant (firma) del user. Cada user nuevo recibe un
 *   tenant ÚNICO (UUID v4). Esto previene data leakage cross-tenant:
 *   sin esto, dos users distintos caerían al mismo tenant "default"
 *   y compartirían toda la data. **CRIT-1 del audit D3.4.**
 *   En D6 (multi-tenant user pool) esto se reemplaza por un flujo de
 *   invitación que asigna tenant_id desde un form.
 * - `socialProviders.google`: único método de auth en D3.4.
 * - `prompt: "select_account"`: siempre muestra el selector de cuenta
 *   de Google (evita que reuse la última cuenta sin querer).
 * - `mapProfileToUser`: genera un tenant_id único para cada user
 *   nuevo vía `tenant-${crypto.randomUUID()}`. Forward-compat: si
 *   queremos tenants descriptivos en el futuro, este hook lee el form
 *   de invitación.
 * - `experimental.joins: false`: joins experimentales en 1.6 los
 *   dejamos off hasta que sean estables (reducir blast radius en D3.4).
 */
export const auth = betterAuth({
  database: db,
  baseURL: BASE_URL,
  secret: SECRET,

  user: {
    modelName: "auth_user",
    additionalFields: {
      default_tenant_id: {
        type: "string",
        required: false,
        defaultValue: "default",
        input: false,
      },
    },
  },

  session: {
    modelName: "auth_session",
    expiresIn: 60 * 60 * 24 * 7, // 7 días
    updateAge: 60 * 60 * 24, // 1 día (sliding renewal)
  },

  account: {
    modelName: "auth_account",
  },

  verification: {
    modelName: "auth_verification",
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      prompt: "select_account",
      mapProfileToUser: () => ({
        // FIX CRIT-1 (audit D3.4, 2026-06-24): cada user nuevo recibe un
        // tenant_id ÚNICO, no el compartido "default". Sin este fix,
        // dos users autenticados con Google caerían al mismo tenant y
        // compartirían toda la data. Forward-compat con D6 (multi-tenant
        // user pool): este hook se reemplaza por lectura de invitación.
        default_tenant_id: `tenant-${crypto.randomUUID()}`,
      }),
    },
  },

  trustedOrigins: [BASE_URL],

  advanced: {
    database: {
      // Reuse nuestro generateId de crypto.randomUUID (consistente con
      // el resto del motor que usa UUIDs).
      generateId: () => crypto.randomUUID(),
    },
  },
});

/**
 * Re-export del DB para que handlers.ts y migrateAuthTables puedan
 * acceder a la misma instancia sin re-importar de db.ts.
 */
export { db } from "../db.js";

/**
 * Corre las migraciones de Better Auth programáticamente.
 *
 * Better Auth provee `getMigrations` de `better-auth/db/migration` que
 * detecta qué tablas/columnas faltan en la DB y las crea/agrega.
 *
 * Esto se usa en lugar de la CLI `npx auth@latest migrate` porque:
 * - Somos un proyecto TS/ESM (la CLI puede tener fricciones)
 * - Forward-compat: si Better Auth agrega columnas en una versión
 *   futura, las migraciones se aplican automáticamente sin tocar este
 *   código.
 * - Idempotente: si las tablas ya existen, no hace nada.
 *
 * Usar desde server.ts al startup:
 * ```ts
 * await runBetterAuthMigrations();
 * ```
 *
 * Spec: AGENT_D3_4_5_DB_AUTH_SPEC.md §4.1 + §4.2.
 */
export async function runBetterAuthMigrations(): Promise<void> {
  const { runMigrations } = await import("better-auth/db/migration").then(
    (m) => m.getMigrations(auth.options),
  );
  await runMigrations();
  console.log("[Better Auth] migrations applied");
}