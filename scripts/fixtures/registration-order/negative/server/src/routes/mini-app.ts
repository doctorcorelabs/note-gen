// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture-only minimal stand-ins for the Fastify types used by the
// registration-order fixtures. Not production code; nothing outside
// scripts/fixtures/registration-order/ imports this module.

export interface FixtureRequest {
  path: string;
}

export interface FixtureReply {
  code(status: number): FixtureReply;
  send(body?: unknown): FixtureReply;
}

export type FixtureHandler = (request: FixtureRequest, reply: FixtureReply) => unknown;

export interface FixtureRouteOptions {
  config?: { requiresAuth?: boolean };
}

export interface FixtureApp {
  get(path: string, options: FixtureRouteOptions, handler: FixtureHandler): void;
  get(path: string, handler: FixtureHandler): void;
  post(path: string, options: FixtureRouteOptions, handler: FixtureHandler): void;
  post(path: string, handler: FixtureHandler): void;
  put(path: string, options: FixtureRouteOptions, handler: FixtureHandler): void;
  put(path: string, handler: FixtureHandler): void;
  route(options: {
    method: string | string[];
    url: string;
    handler: FixtureHandler;
    config?: { requiresAuth?: boolean };
  }): void;
}
