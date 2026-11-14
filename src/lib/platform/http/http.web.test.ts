// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Unit tests for the web HttpAdapter (V2-14).
 *
 * No test runner is configured in package.json. Run with esbuild plus
 * the Node test runner (Node 24):
 *
 *   node_modules/.bin/esbuild src/lib/platform/http/http.web.test.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v2-14-http-web.test.cjs \
 *     && node --test /tmp/v2-14-http-web.test.cjs
 *
 * All network behavior goes through injected fake fetch
 * implementations; no real request is ever made. The fake token
 * "tok-123" below is a fixture, not a credential.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformCapabilityError } from "../errors";
import type { ClientOptions, HttpAdapter } from "./interface";
import { createWebHttpAdapter } from "./http.web";

const BASE_ORIGIN = "https://app.example";

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
};

function makeRecorder() {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response("ok", { status: 200 });
  };
  return { calls, fetchImpl };
}

function hangingFetch(): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      const timer = setTimeout(() => resolve(new Response("late")), 200);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
      void input;
    })) as typeof fetch;
}

async function expectCapability(
  promise: Promise<unknown>,
  expected: { code: string; capability: string; adapter: string; mode: string },
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PlatformCapabilityError, `expected PlatformCapabilityError, got ${String(error)}`);
    assert.equal(error.code, expected.code);
    assert.equal(error.capability, expected.capability);
    assert.equal(error.adapter, expected.adapter);
    assert.equal(error.mode, expected.mode);
    return true;
  });
}

function adapterWith(fetchImpl: typeof fetch, baseOrigin: string | (() => string | null) | null = BASE_ORIGIN): HttpAdapter {
  return createWebHttpAdapter({ fetchImpl, baseOrigin });
}

describe("web HttpAdapter same-origin policy", () => {
  it("allows a relative URL and passes the original string to fetch", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const response = await adapterWith(fetchImpl).fetch("api/workspace/list");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, "api/workspace/list");
  });

  it("allows a root-relative URL", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("/api/workspace/list");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, "/api/workspace/list");
  });

  it("allows an absolute same-origin string", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch(`${BASE_ORIGIN}/api/workspace/list`);
    assert.equal(calls.length, 1);
  });

  it("allows a same-origin URL object and passes its href", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch(new URL(`${BASE_ORIGIN}/api/x`));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, `${BASE_ORIGIN}/api/x`);
  });

  it("allows a same-origin Request and passes the same object", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const request = new Request(`${BASE_ORIGIN}/api/x`);
    await adapterWith(fetchImpl).fetch(request);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, request);
  });

  it("allows a protocol-relative URL to the page origin", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("//app.example/api/x");
    assert.equal(calls.length, 1);
  });

  it("passes method, headers, and body through to fetch", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("/api/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal((calls[0].init?.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.equal(calls[0].init?.body, JSON.stringify({ a: 1 }));
  });
});

describe("web HttpAdapter cross-origin rejection", () => {
  it("rejects a cross-origin URL before any network request", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await expectCapability(adapterWith(fetchImpl).fetch("https://evil.example/api/x"), {
      code: "unsupported",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
  });

  it("names only the origin in the error, never the query token", async () => {
    const { fetchImpl } = makeRecorder();
    await assert.rejects(adapterWith(fetchImpl).fetch("https://evil.example/api/x?token=tok-123"), (error: unknown) => {
      assert.ok(error instanceof PlatformCapabilityError);
      assert.ok(error.reason?.includes("https://evil.example"));
      assert.ok(!error.reason?.includes("tok-123"));
      assert.ok(!error.message.includes("tok-123"));
      return true;
    });
  });

  it("rejects a subdomain as a different origin", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await expectCapability(adapterWith(fetchImpl).fetch("https://api.app.example/x"), {
      code: "unsupported",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
  });

  it("rejects protocol-relative, backslash, and whitespace cross-origin spellings", async () => {
    const spellings = ["//evil.example/x", "\\\\evil.example\\x", "  //evil.example/x"];
    for (const spelling of spellings) {
      const { calls, fetchImpl } = makeRecorder();
      await expectCapability(adapterWith(fetchImpl).fetch(spelling), {
        code: "unsupported",
        capability: "http.fetch",
        adapter: "http",
        mode: "web",
      });
      assert.equal(calls.length, 0);
    }
  });

  it("rejects a cross-origin Request without fetching", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await expectCapability(adapterWith(fetchImpl).fetch(new Request("https://evil.example/x")), {
      code: "unsupported",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
  });
});

describe("web HttpAdapter scheme, credential, and input validation", () => {
  it("rejects non-http(s) schemes", async () => {
    for (const input of ["ftp://app.example/x", "javascript:alert(1)", "data:text/plain,hi"]) {
      const { calls, fetchImpl } = makeRecorder();
      await expectCapability(adapterWith(fetchImpl).fetch(input), {
        code: "unsupported",
        capability: "http.fetch",
        adapter: "http",
        mode: "web",
      });
      assert.equal(calls.length, 0);
    }
  });

  it("rejects embedded credentials in an absolute URL", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await expectCapability(adapterWith(fetchImpl).fetch("https://user:pass@app.example/api/x"), {
      code: "invalid_argument",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
  });

  it("rejects embedded credentials in a protocol-relative same-origin URL", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await expectCapability(adapterWith(fetchImpl).fetch("//user:pass@app.example/api/x"), {
      code: "invalid_argument",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
  });

  it("rejects an empty or whitespace-only URL with TypeError", async () => {
    for (const input of ["", "   "]) {
      const { calls, fetchImpl } = makeRecorder();
      await assert.rejects(adapterWith(fetchImpl).fetch(input), TypeError);
      assert.equal(calls.length, 0);
    }
  });
});

describe("web HttpAdapter base origin handling", () => {
  it("rejects every absolute URL when the origin is unknown, but allows relative URLs", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const adapter = createWebHttpAdapter({ fetchImpl, baseOrigin: null });
    await expectCapability(adapter.fetch(`${BASE_ORIGIN}/api/x`), {
      code: "unsupported",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
    await adapter.fetch("api/x");
    assert.equal(calls.length, 1);
  });

  it("supports a thunk base origin returning null", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const adapter = createWebHttpAdapter({ fetchImpl, baseOrigin: () => null });
    await expectCapability(adapter.fetch(`${BASE_ORIGIN}/api/x`), {
      code: "unsupported",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
    assert.equal(calls.length, 0);
  });

  it("uses only the origin part of a base origin carrying path and query", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const adapter = createWebHttpAdapter({ fetchImpl, baseOrigin: `${BASE_ORIGIN}/some/path?x=1` });
    await adapter.fetch(`${BASE_ORIGIN}/api/x`);
    assert.equal(calls.length, 1);
    await expectCapability(adapter.fetch("https://other.example/x"), {
      code: "unsupported",
      capability: "http.fetch",
      adapter: "http",
      mode: "web",
    });
  });

  it("throws TypeError at factory time for an invalid base origin", () => {
    const { fetchImpl } = makeRecorder();
    assert.throws(() => createWebHttpAdapter({ fetchImpl, baseOrigin: "not a url" }), TypeError);
  });
});

describe("web HttpAdapter ClientOptions mapping", () => {
  it("rejects a non-empty proxy configuration", async () => {
    const proxies: ClientOptions["proxy"][] = [
      { all: "http://proxy:8080" },
      { http: "http://proxy:8080" },
      { all: { url: "http://proxy:8080" } },
    ];
    for (const proxy of proxies) {
      const { calls, fetchImpl } = makeRecorder();
      await expectCapability(adapterWith(fetchImpl).fetch("/api/x", { proxy }), {
        code: "unsupported",
        capability: "http.fetch.proxy",
        adapter: "http",
        mode: "web",
      });
      assert.equal(calls.length, 0);
    }
  });

  it("treats an empty proxy object as absent and strips it from the fetch init", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("/api/x", { proxy: {} });
    assert.equal(calls.length, 1);
    assert.ok(!("proxy" in (calls[0].init ?? {})));
  });

  it("rejects enabled danger flags", async () => {
    for (const danger of [{ acceptInvalidCerts: true }, { acceptInvalidHostnames: true }]) {
      const { calls, fetchImpl } = makeRecorder();
      await expectCapability(adapterWith(fetchImpl).fetch("/api/x", { danger }), {
        code: "unsupported",
        capability: "http.fetch.danger",
        adapter: "http",
        mode: "web",
      });
      assert.equal(calls.length, 0);
    }
  });

  it("treats all-false danger flags as absent", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("/api/x", {
      danger: { acceptInvalidCerts: false, acceptInvalidHostnames: false },
    });
    assert.equal(calls.length, 1);
  });

  it("maps maxRedirections 0 to manual and positive values to follow", async () => {
    const { calls: zeroCalls, fetchImpl: zeroFetch } = makeRecorder();
    await adapterWith(zeroFetch).fetch("/api/x", { maxRedirections: 0 });
    assert.equal(zeroCalls[0].init?.redirect, "manual");
    const { calls: manyCalls, fetchImpl: manyFetch } = makeRecorder();
    await adapterWith(manyFetch).fetch("/api/x", { maxRedirections: 5 });
    assert.equal(manyCalls[0].init?.redirect, "follow");
  });

  it("leaves redirect untouched when maxRedirections is absent", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("/api/x", { redirect: "error" });
    assert.equal(calls[0].init?.redirect, "error");
  });

  it("rejects invalid maxRedirections and connectTimeout values with TypeError", async () => {
    const inits: (RequestInit & ClientOptions)[] = [
      { maxRedirections: -1 },
      { maxRedirections: 1.5 },
      { connectTimeout: -1 },
      { connectTimeout: Number.NaN },
      { connectTimeout: Number.POSITIVE_INFINITY },
    ];
    for (const init of inits) {
      const { calls, fetchImpl } = makeRecorder();
      await assert.rejects(adapterWith(fetchImpl).fetch("/api/x", init), TypeError);
      assert.equal(calls.length, 0);
    }
  });

  it("treats connectTimeout 0 as no timeout", async () => {
    const { calls, fetchImpl } = makeRecorder();
    await adapterWith(fetchImpl).fetch("/api/x", { connectTimeout: 0 });
    assert.equal(calls.length, 1);
  });

  it("never mutates the caller init object and strips plugin-only keys", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const init: RequestInit & ClientOptions = {
      method: "GET",
      maxRedirections: 3,
      connectTimeout: 5000,
      proxy: {},
      danger: {},
    };
    await adapterWith(fetchImpl).fetch("/api/x", init);
    assert.equal(init.maxRedirections, 3);
    assert.equal(init.connectTimeout, 5000);
    assert.deepEqual(init.proxy, {});
    assert.deepEqual(init.danger, {});
    const sent = calls[0].init as unknown as Record<string, unknown>;
    assert.ok(!("maxRedirections" in sent));
    assert.ok(!("connectTimeout" in sent));
    assert.ok(!("proxy" in sent));
    assert.ok(!("danger" in sent));
  });
});

describe("web HttpAdapter timeout and abort", () => {
  it("rejects with TimeoutError when connectTimeout fires", async () => {
    const adapter = createWebHttpAdapter({ fetchImpl: hangingFetch(), baseOrigin: BASE_ORIGIN });
    await assert.rejects(adapter.fetch("/api/x", { connectTimeout: 20 }), (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "TimeoutError");
      return true;
    });
  });

  it("rejects without fetching when the caller signal is already aborted", async () => {
    const { calls, fetchImpl } = makeRecorder();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapterWith(fetchImpl).fetch("/api/x", { signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("propagates a caller abort during flight", async () => {
    const adapter = createWebHttpAdapter({ fetchImpl: hangingFetch(), baseOrigin: BASE_ORIGIN });
    const controller = new AbortController();
    const pending = adapter.fetch("/api/x", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "AbortError");
      return true;
    });
  });
});
