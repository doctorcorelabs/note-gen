// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Default workspace resolution for the db routes.
//
// The workspace never comes from the request (kontrak 1.1): it is
// resolved server-side from the authenticated session. MVP is
// single-user with one default workspace per account, so the
// resolver returns the earliest workspace the user belongs to,
// ordered by creation time, then id, for determinism.
//
// Resolution order:
// 1. A workspace with a workspace_members row for the user (the
//    authorization model: no member row means no access).
// 2. Fallback: a workspace owned by the user. The owner is by
//    definition authorized, so this only tolerates a bootstrap that
//    created the workspace row without its member row.
// When neither exists, the resolver returns null and dispatch
// answers 404 not_found generically (AD-08): a missing workspace
// and a denied workspace are indistinguishable to the client.
//
// The resolver runs inside the request transaction, so the
// membership check and the operations see one consistent snapshot.
// A user id that is not a valid UUID returns null instead of
// reaching the database: session principals always carry UUID user
// ids, and an invalid value means a corrupt session, answered
// fail-closed with the same generic 404.

import { asc, eq } from 'drizzle-orm';
import { workspaceMembers, workspaces } from '../../db/index.js';
import type { DbTransaction } from './registry.js';

export type WorkspaceResolver = (tx: DbTransaction, userId: string) => Promise<string | null>;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const resolveDefaultWorkspaceId: WorkspaceResolver = async (
  tx: DbTransaction,
  userId: string,
): Promise<string | null> => {
  if (!UUID_PATTERN.test(userId)) {
    return null;
  }
  const memberRows = await tx
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (memberRows.length > 0) {
    return memberRows[0].workspaceId;
  }
  const ownedRows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (ownedRows.length > 0) {
    return ownedRows[0].id;
  }
  return null;
};
