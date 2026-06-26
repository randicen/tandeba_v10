/**
 * Worgena — Firm management (D3.4 redesign).
 *
 * Lógica de negocio para multi-tenant multi-user firm. NO expone endpoints
 * HTTP — eso es responsabilidad de `server.ts`. Solo operaciones puras sobre
 * la DB.
 *
 * Funciones:
 * - `createFirm(name, nit?, ownerUserId)` — crea tenant + tenant_members(owner)
 * - `joinFirmViaInvite(userId, token)` — valida invitation, crea tenant_members(member)
 * - `createInvitation(tenantId, email?, role, inviterUserId)` — owner/admin
 * - `revokeInvitation(invitationId, requesterUserId)` — owner/admin
 * - `getUserFirms(userId)` — lista firms del user
 * - `getActiveFirmId(userId, sessionId)` — para auto-setear activeFirmId si el user tiene 1 firm
 * - `listMembers(tenantId, requesterUserId)` — owner/admin pueden ver
 * - `getFirm(tenantId)` — para verificación
 *
 * Multi-tenant desde el inicio (ver AGENT_D3_4_REDESIGN_SPRINT_SPEC.md §6):
 * - Mismo code path para todos los users
 * - Primer user: "Crear firm" → owner
 * - N-ésimo: "Unirse con invite" → member
 * - NO auto-asumimos firm para nadie
 *
 * Schema compatible con Postgres (TEXT/INTEGER/UNIQUE, sin SQLite-specific).
 */

// D3.4 redesign: cada función acepta `db` como parámetro. Esto permite:
// 1. Testing con `:memory:` sin contaminar la DB real
// 2. Forward-compat con multi-DB (per-tenant DB en futuro)
// El default en `index.ts` re-exporta las funciones con el `db` global
// de `db.ts` (worgena.db) para mantener la API existente.
import type Database from "better-sqlite3";

// Tipo para el "default db" que se usa si no se pasa uno.
// En runtime es `worgena.db` (de `db.ts`). En tests es `:memory:`.
let _defaultDb: Database.Database | null = null;

export function setDefaultDb(db: Database.Database): void {
  _defaultDb = db;
}

function getDb(): Database.Database {
  if (!_defaultDb) {
    // Lazy import: cuando se llama por primera vez en runtime, importa
    // el db global. En tests, setDefaultDb() se llama antes de las
    // funciones, así que esto nunca se ejecuta.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    throw new Error(
      "firm: default db not set. Call setDefaultDb() first or pass db explicitly.",
    );
  }
  return _defaultDb;
}

export type FirmRole = "owner" | "admin" | "member";

export interface Tenant {
  id: string;
  name: string;
  nit: string | null;
  createdAt: number;
  createdBy: string;
  archivedAt: number | null;
}

export interface TenantMember {
  id: string;
  userId: string;
  tenantId: string;
  role: FirmRole;
  joinedAt: number;
  invitedBy: string | null;
}

export interface TenantInvitation {
  id: string;
  tenantId: string;
  email: string | null;
  role: FirmRole;
  token: string;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  createdAt: number;
  createdBy: string;
}

export interface FirmWithRole {
  firm: Tenant;
  role: FirmRole;
  joinedAt: number;
}

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

/**
 * Crea un firm + agrega al owner como tenant_members.
 *
 * Transacción: ambas inserciones o ninguna. Si falla el INSERT de tenant_members,
 * el tenant queda pero sin owner. Con BEGIN/COMMIT garantizamos atomicidad.
 */
export function createFirm(
  name: string,
  ownerUserId: string,
  nit?: string,
  dbInstance?: Database.Database,
): Tenant {
  // Validaciones
  if (!name || name.trim().length === 0) {
    throw new Error("createFirm: name is required");
  }
  if (!ownerUserId) {
    throw new Error("createFirm: ownerUserId is required");
  }

  const db = dbInstance ?? getDb();
  const tenantId = `firm-${crypto.randomUUID()}`;
  const now = Date.now();

  // Transacción: ambas inserts o ninguna.
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO tenants (id, name, nit, created_at, created_by, archived_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(tenantId, name.trim(), nit?.trim() ?? null, now, ownerUserId);

    db.prepare(
      `INSERT INTO tenant_members (id, user_id, tenant_id, role, joined_at, invited_by)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      `tm-${crypto.randomUUID()}`,
      ownerUserId,
      tenantId,
      "owner",
      now,
    );
  });
  txn();

  return {
    id: tenantId,
    name: name.trim(),
    nit: nit?.trim() ?? null,
    createdAt: now,
    createdBy: ownerUserId,
    archivedAt: null,
  };
}

/**
 * Une un user a un firm vía invitation token.
 *
 * Validaciones:
 * - Token existe
 * - Token no expirado
 * - Token no usado
 *
 * Transacción: marca used_at/used_by + crea tenant_members.
 */
export function joinFirmViaInvite(
  userId: string,
  token: string,
  dbInstance?: Database.Database,
): { firm: Tenant; role: FirmRole } {
  if (!userId || !token) {
    throw new Error("joinFirmViaInvite: userId and token are required");
  }

  const db = dbInstance ?? getDb();
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT * FROM tenant_invitations WHERE token = ? AND used_at IS NULL`,
    )
    .get(token) as
    | {
        id: string;
        tenant_id: string;
        role: FirmRole;
        expires_at: number;
        created_by: string;
        used_at: number | null;
      }
    | undefined;

  if (!row) {
    throw new Error("joinFirmViaInvite: invalid or used token");
  }
  if (row.expires_at < now) {
    throw new Error("joinFirmViaInvite: token expired");
  }

  const tenant = getFirm(row.tenant_id, db);
  if (!tenant) {
    throw new Error("joinFirmViaInvite: firm not found or archived");
  }

  const txn = db.transaction(() => {
    // Marcar invitation como usada
    db.prepare(
      `UPDATE tenant_invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`,
    ).run(now, userId, row.id);

    // Crear tenant_member. Si ya existe (UNIQUE constraint), el INSERT
    // falla. Eso es OK — el user ya estaba en el firm.
    db.prepare(
      `INSERT INTO tenant_members (id, user_id, tenant_id, role, joined_at, invited_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `tm-${crypto.randomUUID()}`,
      userId,
      row.tenant_id,
      row.role,
      now,
      row.created_by,
    );
  });
  txn();

  return { firm: tenant, role: row.role };
}

/**
 * Crea una invitación. Solo owner/admin pueden.
 *
 * @param tenantId - firm al que se invita
 * @param inviterUserId - user que crea la invitación (debe ser owner/admin)
 * @param email - opcional, pre-fill
 * @param role - default 'member'
 */
export function createInvitation(
  tenantId: string,
  inviterUserId: string,
  email?: string,
  role: FirmRole = "member",
  dbInstance?: Database.Database,
): { id: string; token: string; expiresAt: number } {
  const db = dbInstance ?? getDb();
  // Validar que inviter es owner/admin
  const member = db
    .prepare(
      `SELECT role FROM tenant_members WHERE user_id = ? AND tenant_id = ?`,
    )
    .get(inviterUserId, tenantId) as { role: FirmRole } | undefined;
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new Error(
      "createInvitation: only owner/admin can create invitations",
    );
  }
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new Error(`createInvitation: invalid role "${role}"`);
  }

  const now = Date.now();
  const id = `inv-${crypto.randomUUID()}`;
  const token = crypto.randomUUID();
  const expiresAt = now + INVITATION_EXPIRY_MS;

  db.prepare(
    `INSERT INTO tenant_invitations
       (id, tenant_id, email, role, token, expires_at, used_at, used_by, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    tenantId,
    email?.trim() ?? null,
    role,
    token,
    expiresAt,
    now,
    inviterUserId,
  );

  // P0 #5 jobs: encolar email de invitación. Cierra la mitad funcional
  // de D3.4. Si el email no se pasó en el form, NO encolamos (no podemos
  // mandar sin destino). Si el sistema de jobs no está disponible (e.g.
  // en un test aislado), lo tragamos silenciosamente: la invitación está
  // creada, el admin puede re-enviar manualmente via UI v2.
  //
  // Usamos setImmediate + dynamic import porque createInvitation es sync
  // (forward-compat con tests pre-jobs que lo llaman sin await).
  if (email && email.trim().length > 0) {
    setImmediate(() => {
      void import("../jobs/repository.js")
        .then(({ enqueueJob }) => {
          enqueueJob(
            "send_invitation_email",
            { invitationId: id },
            { idempotencyKey: `invite-${id}` },
            db,
          );
        })
        .catch((e: Error) => {
          console.warn(
            `[createInvitation] failed to enqueue send_invitation_email (id=${id}): ${e.message}`,
          );
        });
    });
  }

  return { id, token, expiresAt };
}

/**
 * Revoca una invitación (marca used_at = now). Solo owner/admin del firm
 * pueden.
 */
export function revokeInvitation(
  invitationId: string,
  requesterUserId: string,
  dbInstance?: Database.Database,
): void {
  const db = dbInstance ?? getDb();
  const inv = db
    .prepare(
      "SELECT id, tenant_id as tenantId, used_at as usedAt FROM tenant_invitations WHERE id = ?",
    )
    .get(invitationId) as
    | { id: string; tenantId: string; usedAt: number | null }
    | undefined;
  if (!inv) {
    throw new Error("revokeInvitation: invitation not found");
  }
  // Verificar que requester es owner/admin del firm
  const member = db
    .prepare(
      `SELECT role FROM tenant_members WHERE user_id = ? AND tenant_id = ?`,
    )
    .get(requesterUserId, inv.tenantId) as { role: FirmRole } | undefined;
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new Error(
      "revokeInvitation: only owner/admin can revoke invitations",
    );
  }
  if (inv.usedAt !== null) {
    throw new Error("revokeInvitation: invitation already used");
  }
  db.prepare(
    "UPDATE tenant_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL",
  ).run(Date.now(), invitationId);
}

/**
 * Lista los firms a los que pertenece el user, con su rol y fecha de
 * ingreso. Ordenados por fecha de ingreso ascendente.
 */
export function getUserFirms(
  userId: string,
  dbInstance?: Database.Database,
): FirmWithRole[] {
  const db = dbInstance ?? getDb();
  const rows = db
    .prepare(
      `SELECT t.id as id, t.name as name, t.nit as nit, t.created_at as createdAt,
              t.created_by as createdBy, t.archived_at as archivedAt,
              tm.role as role, tm.joined_at as joinedAt
       FROM tenants t
       JOIN tenant_members tm ON tm.tenant_id = t.id
       WHERE tm.user_id = ? AND t.archived_at IS NULL
       ORDER BY tm.joined_at ASC`,
    )
    .all(userId) as Array<{
      id: string;
      name: string;
      nit: string | null;
      createdAt: number;
      createdBy: string;
      archivedAt: number | null;
      role: FirmRole;
      joinedAt: number;
    }>;

  return rows.map((r) => ({
    firm: {
      id: r.id,
      name: r.name,
      nit: r.nit,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      archivedAt: r.archivedAt,
    },
    role: r.role,
    joinedAt: r.joinedAt,
  }));
}

/**
 * Para auto-setear activeFirmId en la sesión cuando el user tiene
 * exactamente 1 firm. Si tiene 0, retorna null (onboarding requerido).
 * Si tiene N>1, retorna null (forward-compat: UI selector en D6).
 */
export function getSingleActiveFirmId(
  userId: string,
  dbInstance?: Database.Database,
): string | null {
  const firms = getUserFirms(userId, dbInstance);
  if (firms.length === 1) {
    return firms[0]!.firm.id;
  }
  return null; // 0 firms → onboarding; N>1 firms → UI selector (D6)
}

/**
 * Lista los miembros de un firm. Solo owner/admin pueden listar.
 */
export interface FirmMember {
  userId: string;
  email: string | null; // de auth_user, via JOIN
  role: FirmRole;
  joinedAt: number;
  invitedBy: string | null;
}

export function listMembers(
  tenantId: string,
  requesterUserId: string,
  dbInstance?: Database.Database,
): FirmMember[] {
  const db = dbInstance ?? getDb();
  // Verificar acceso
  const requester = db
    .prepare(
      `SELECT role FROM tenant_members WHERE user_id = ? AND tenant_id = ?`,
    )
    .get(requesterUserId, tenantId) as { role: FirmRole } | undefined;
  if (!requester) {
    throw new Error("listMembers: requester is not a member of this firm");
  }

  // Cualquier miembro puede ver la lista (no solo owner/admin).
  // Si quieres restringir, agregar check aquí.
  const rows = db
    .prepare(
      `SELECT tm.user_id as userId, tm.role as role, tm.joined_at as joinedAt,
              tm.invited_by as invitedBy, au.email as email
       FROM tenant_members tm
       LEFT JOIN auth_user au ON au.id = tm.user_id
       WHERE tm.tenant_id = ?
       ORDER BY tm.joined_at ASC`,
    )
    .all(tenantId) as Array<{
      userId: string;
      email: string | null;
      role: FirmRole;
      joinedAt: number;
      invitedBy: string | null;
    }>;
  return rows;
}

/**
 * Helper: get firm by id.
 */
export function getFirm(
  tenantId: string,
  dbInstance?: Database.Database,
): Tenant | null {
  const db = dbInstance ?? getDb();
  const row = db
    .prepare(
      "SELECT id, name, nit, created_at as createdAt, created_by as createdBy, archived_at as archivedAt FROM tenants WHERE id = ? AND archived_at IS NULL",
    )
    .get(tenantId) as
    | {
        id: string;
        name: string;
        nit: string | null;
        createdAt: number;
        createdBy: string;
        archivedAt: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    nit: row.nit,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt,
  };
}

/**
 * Helper: check if user is member of firm (any role).
 */
export function isMemberOf(
  userId: string,
  tenantId: string,
  dbInstance?: Database.Database,
): { isMember: boolean; role: FirmRole | null } {
  const db = dbInstance ?? getDb();
  const row = db
    .prepare(
      "SELECT role FROM tenant_members WHERE user_id = ? AND tenant_id = ?",
    )
    .get(userId, tenantId) as { role: FirmRole } | undefined;
  return {
    isMember: !!row,
    role: row?.role ?? null,
  };
}
