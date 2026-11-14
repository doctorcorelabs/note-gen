// SPDX-License-Identifier: GPL-3.0-only
// WIP skeleton: mock server for workspace/files conformance tests.
// Full implementation follows in later commits on this branch.
import http from "node:http";

export function createMockServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "Not found.", requestId: "req-mock-wip", retryable: false, details: {} } }));
  });
  return server;
}

export async function startMockServer() {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, store: null };
}
