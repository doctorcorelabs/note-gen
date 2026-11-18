// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Cloudflare Access exemption predicate (desain-auth.md section 7.5;
// AD-132, PREDEPLOY finding F-02; AD-133). This is the isExempt predicate the
// verifier module (middleware/cf-access.ts) leaves to the integrator:
// it decides which requests skip origin JWT verification, and it is
// the ONLY exemption policy in the wired application. Anything this
// predicate does not exempt is verified, including unmatched paths.
//
// Exemptions, exactly as section 7.5 writes them:
//
// 1. GET /api/health/live is exempt for every peer. Section 7.5 lists
//    it as the exemption, with no peer condition; liveness carries no
//    user data (it proves only that the process answers), and
//    orchestrator probes must reach it without credentials. The
//    public path still passes through the Access policy at the edge;
//    origin verification is what is skipped here, by design.
// 2. GET /api/health/ready is NOT exempt on the public path: a
//    watchdog probe through the public URL must carry a valid service
//    token (section 7.6 item (g)). It is exempt ONLY when the request
//    arrives from the loopback interface, which is the conservative
//    reading of the section 7.5 internal-network rule: the design
//    requires the two paths (public Caddy versus internal compose
//    network) to be told apart from network origin, never from a
//    header, but leaves the mechanism to the infra owner, and no
//    separate internal listener exists in this deployment. Loopback
//    covers the container healthcheck, which calls the API on
//    127.0.0.1 directly (design 10, section 9.4). A probe that
//    arrives from any other peer address, including another compose
//    container or Caddy forwarding a public request, must carry a
//    valid JWT. AD-133(1) confirms the watchdog call path: direct
//    loopback to the API, or via Caddy with a valid service token.
//    Loopback-only is the confirmed reading, and no separate
//    internal listener is adopted in Fase 1. This predicate
//    never inspects headers: a forged X-Forwarded-For cannot
//    manufacture an exemption.
// 3. GET /api/health, the alias that runs the exact same ready
//    handler (routes/health.ts), is treated exactly like ready.
//    Section 7.5 does not name the alias; treating it as live-exempt
//    would open the ready check without a token, so the conservative
//    reading applies, confirmed by AD-133(2).
//
// What is NOT exempt: every other method and path, including POST to
// a health path (the exemptions are GET-only), every session-public
// path (session exemptions in middleware/auth-hook.ts are a
// different layer and never imply an Access exemption), and every
// unmatched path (an unknown path without a JWT answers 401, not
// 404, while verification is enabled; with a valid JWT it answers
// 404 as before). Static files are out of scope here: the API serves
// no static routes, so the section 7.5 static-files paragraph does
// not apply to this service; the web service is a separate
// deployment question (AD-133(4)).

import type { FastifyRequest } from 'fastify';
import { HEALTH_ALIAS_PATH, HEALTH_LIVE_PATH, HEALTH_READY_PATH } from '../routes/health.js';

// Loopback peer addresses, including the IPv4-mapped IPv6 form a
// dual-stack socket reports for 127.0.0.1. No other address is
// loopback for this predicate: the whole 127/8 range is deliberately
// NOT accepted, because the healthcheck uses 127.0.0.1 exactly and a
// wider range would only widen the exemption.
const LOOPBACK_PEER_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackPeerAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_PEER_ADDRESSES.has(address);
}

// The direct peer address of the TCP connection, read from the
// socket only. Headers play no part: the Fastify instance sets no
// trustProxy option, and this function does not consult request.ip
// or any forwarded header, so no header value can influence the
// result. An unknown peer address is not loopback (fail closed).
export function requestPeerAddress(request: FastifyRequest): string | undefined {
  const holder = request as unknown as {
    socket?: { remoteAddress?: unknown };
    raw?: { socket?: { remoteAddress?: unknown } };
  };
  const direct = holder.socket?.remoteAddress;
  if (typeof direct === 'string' && direct !== '') {
    return direct;
  }
  const raw = holder.raw?.socket?.remoteAddress;
  if (typeof raw === 'string' && raw !== '') {
    return raw;
  }
  return undefined;
}

function requestPath(request: FastifyRequest): string {
  const url = request.url;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

export function isCfAccessExemptRequest(request: FastifyRequest): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  const path = requestPath(request);
  if (path === HEALTH_LIVE_PATH) {
    return true;
  }
  if (path === HEALTH_READY_PATH || path === HEALTH_ALIAS_PATH) {
    return isLoopbackPeerAddress(requestPeerAddress(request));
  }
  return false;
}
