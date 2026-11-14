// SPDX-License-Identifier: GPL-3.0-only
// Conformance: media upload (PUT raw, POST multipart), media read
// (GET/HEAD), Range, disposition, and revision guards. Contract:
// kontrak-api-kanonis.md section 3.1; V1-09 sections 7.2, 7.3.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIsoUtc,
  createFile,
  expectError,
  expectOk,
  mkdirOk,
  query,
  request,
  setupContext,
  skipUnlessMock,
} from "./helpers.mjs";

const ctx = await setupContext();

// A genuine 1x1 transparent PNG (68 bytes).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mediaUrl(path) {
  return `/api/workspace/media/${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

async function putMedia(path, bytes, extraHeaders = {}) {
  return request(ctx, "PUT", `/api/workspace/media${query({ path })}`, {
    headers: { "Content-Type": "application/octet-stream", ...extraHeaders },
    body: bytes,
  });
}

function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) header += `; filename="${part.filename}"`;
    header += "\r\n";
    if (part.contentType !== undefined) header += `Content-Type: ${part.contentType}\r\n`;
    header += "\r\n";
    chunks.push(Buffer.from(header, "utf8"));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

async function postMultipart(parts, extraHeaders = {}, boundary = "----conformance-boundary") {
  return request(ctx, "POST", "/api/workspace/media", {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...extraHeaders },
    body: buildMultipart(boundary, parts),
  });
}

function assertMediaShape(data, path, size) {
  assert.equal(data.path, path);
  assert.ok(data.revision.startsWith("sha256:"));
  assert.ok(Number.isInteger(data.version));
  assert.equal(data.size, size);
  assert.equal(typeof data.mimeType, "string");
  assert.equal(typeof data.detectedType, "string");
  assert.ok(data.disposition === "inline" || data.disposition === "attachment");
  assert.equal(typeof data.mediaUrl, "string");
  assertIsoUtc(data.modifiedAt);
}

function assertConflictDetails(error, path) {
  const d = error.details;
  assert.equal(d.path, path);
  assert.ok(d.serverRevision.startsWith("sha256:"));
  assert.ok(Number.isInteger(d.serverVersion));
  assertIsoUtc(d.serverModifiedAt);
  assert.ok(Number.isInteger(d.serverSize));
  assert.equal(typeof d.suggestedCopyPath, "string");
  assert.deepEqual(d.actions, ["reload", "saveAsCopy", "forceOverwrite"]);
}

test("PUT media creates a PNG with the full response shape and headers", async () => {
  const path = ctx.path("media", "pic.png");
  const resp = await putMedia(path, PNG_1X1, { "If-None-Match": "*" });
  const data = expectOk(resp, 201, "PUT media create");
  assertMediaShape(data, path, PNG_1X1.length);
  assert.equal(data.version, 1);
  assert.equal(data.mimeType, "image/png");
  assert.equal(data.detectedType, "png");
  assert.equal(data.disposition, "inline");
  assert.equal(data.mediaUrl, mediaUrl(path));
  assert.equal(resp.headers.get("ETag"), `"${data.revision}"`);
  assert.equal(resp.headers.get("X-Revision"), data.revision);
});

test("PUT mediaUrl round-trips to the exact bytes", async () => {
  const path = ctx.path("media", "roundtrip.png");
  const up = await putMedia(path, PNG_1X1, { "If-None-Match": "*" });
  const data = expectOk(up, 201, "PUT media round-trip");
  const get = await request(ctx, "GET", data.mediaUrl);
  assert.equal(get.status, 200);
  assert.ok(get.bytes.equals(PNG_1X1));
});

test("PUT media overwrite with If-Match bumps the version", async () => {
  const path = ctx.path("media", "overwrite.png");
  const created = expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const resp = await putMedia(path, PNG_1X1, { "If-Match": `"${created.revision}"` });
  const data = expectOk(resp, 200, "PUT media overwrite");
  assert.equal(data.version, 2);
  // Same path and same bytes: the revision formula yields the same value.
  assert.equal(data.revision, created.revision);
});

test("PUT media with a stale If-Match returns 412 revision_conflict", async () => {
  const path = ctx.path("media", "stale.png");
  const created = expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  // Change the bytes so the revision moves; same bytes would keep it.
  const other = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(16, 0)]);
  expectOk(await putMedia(path, other, { "If-Match": `"${created.revision}"` }), 200, "PUT media overwrite");
  const resp = await putMedia(path, PNG_1X1, { "If-Match": `"${created.revision}"` });
  const error = expectError(resp, 412, "revision_conflict");
  assertConflictDetails(error, path);
  assert.equal(error.details.serverVersion, 2);
});

test("PUT media without a guard returns 428, conflicting guards return 400", async () => {
  const path = ctx.path("media", "noguard.png");
  const none = await putMedia(path, PNG_1X1);
  expectError(none, 428, "precondition_required");
  const both = await putMedia(path, PNG_1X1, { "If-Match": `"sha256:abc"`, "If-None-Match": "*" });
  expectError(both, 400, "invalid_precondition");
  const badNone = await putMedia(path, PNG_1X1, { "If-None-Match": `"sha256:abc"` });
  expectError(badNone, 400, "invalid_precondition");
});

test("PUT media If-None-Match star on an existing file returns 409", async () => {
  const path = ctx.path("media", "exists.png");
  expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const resp = await putMedia(path, PNG_1X1, { "If-None-Match": "*" });
  expectError(resp, 409, "already_exists");
});

test("PUT media If-Match star force-overwrites with new content", async () => {
  const path = ctx.path("media", "forced.txt");
  expectOk(await putMedia(path, Buffer.from("v1", "utf8"), { "If-None-Match": "*" }), 201, "PUT media text create");
  const resp = await putMedia(path, Buffer.from("v2 content", "utf8"), { "If-Match": "*" });
  const data = expectOk(resp, 200, "PUT media force");
  assert.equal(data.version, 2);
  const get = await request(ctx, "GET", mediaUrl(path));
  assert.equal(get.text, "v2 content");
});

test("PUT media rejects mismatched and dangerous types with 415", async () => {
  const cases = [
    [ctx.path("media", "wrong-ext.jpg"), PNG_1X1],
    [ctx.path("media", "html.png"), Buffer.from("<html><body>x</body></html>", "utf8")],
    [ctx.path("media", "random.png"), Buffer.from("this is not an image", "utf8")],
    [ctx.path("media", "page.html"), PNG_1X1],
    [ctx.path("media", "script.js"), Buffer.from("console.log(1)", "utf8")],
  ];
  for (const [path, bytes] of cases) {
    const resp = await putMedia(path, bytes, { "If-None-Match": "*" });
    expectError(resp, 415, "unsupported_media_type", `PUT ${path}`);
  }
});

test("PUT media SVG is stored but served as an attachment", async () => {
  const path = ctx.path("media", "icon.svg");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
  const up = await putMedia(path, svg, { "If-None-Match": "*" });
  const data = expectOk(up, 201, "PUT media svg");
  assert.equal(data.mimeType, "application/octet-stream");
  assert.equal(data.detectedType, "svg");
  assert.equal(data.disposition, "attachment");
  const get = await request(ctx, "GET", mediaUrl(path));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("Content-Type"), "application/octet-stream");
  assert.ok(get.headers.get("Content-Disposition").startsWith("attachment"));
  assert.equal(get.headers.get("Content-Security-Policy"), null);
});

test("PUT media text files are accepted, invalid UTF-8 is rejected", async () => {
  const path = ctx.path("media", "note.txt");
  const up = await putMedia(path, Buffer.from("hello", "utf8"), { "If-None-Match": "*" });
  const data = expectOk(up, 201, "PUT media txt");
  assert.equal(data.detectedType, "text");
  assert.equal(data.disposition, "attachment");
  const bad = await putMedia(ctx.path("media", "bad.txt"), Buffer.from([0xff, 0xfe]), { "If-None-Match": "*" });
  expectError(bad, 415, "unsupported_media_type");
});

test("PUT media rejects directory and invalid paths with 400", async () => {
  const folder = ctx.path("media", "adir");
  await mkdirOk(ctx, folder);
  const dir = await putMedia(folder, PNG_1X1, { "If-None-Match": "*" });
  expectError(dir, 400, "invalid_path");
  const invalid = await putMedia("../escape.png", PNG_1X1, { "If-None-Match": "*" });
  expectError(invalid, 400, "invalid_path");
});

test("PUT media of exactly 20 MiB succeeds at the limit", async () => {
  const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(20 * 1024 * 1024 - PNG_SIGNATURE.length, 0)]);
  const resp = await putMedia(ctx.path("media", "exact-limit.png"), bytes, { "If-None-Match": "*" });
  const data = expectOk(resp, 201, "PUT media exactly 20 MiB");
  assert.equal(data.size, 20 * 1024 * 1024);
});

test("PUT media over 20 MiB returns 413 media_too_large", async () => {
  const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(20 * 1024 * 1024 + 1 - PNG_SIGNATURE.length, 0)]);
  const resp = await putMedia(ctx.path("media", "huge.png"), bytes, { "If-None-Match": "*" });
  expectError(resp, 413, "media_too_large");
});

test("PUT media idempotency key replays without rewriting", async () => {
  const path = ctx.path("media", "idem.png");
  const key = `idem-media-${Date.now()}`;
  const headers = { "If-None-Match": "*", "Idempotency-Key": key };
  const first = await putMedia(path, PNG_1X1, headers);
  const firstData = expectOk(first, 201, "PUT media idem first");
  const second = await putMedia(path, PNG_1X1, headers);
  const secondData = expectOk(second, 201, "PUT media idem replay");
  assert.deepEqual(secondData, firstData);
  const stat = await request(ctx, "GET", `/api/workspace/stat${query({ path })}`);
  assert.equal(expectOk(stat, 200, "stat after replay").version, 1);
});

test("GET media returns bytes with inline headers", async () => {
  const path = ctx.path("media", "headers.png");
  const created = expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const get = await request(ctx, "GET", mediaUrl(path));
  assert.equal(get.status, 200);
  assert.ok(get.bytes.equals(PNG_1X1));
  assert.equal(get.headers.get("Content-Type"), "image/png");
  assert.equal(get.headers.get("ETag"), `"${created.revision}"`);
  assert.equal(get.headers.get("X-Revision"), created.revision);
  assert.equal(get.headers.get("Content-Disposition"), "inline");
  assert.equal(get.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(get.headers.get("Content-Security-Policy"), "sandbox");
  assert.equal(get.headers.get("Accept-Ranges"), "bytes");
  assert.equal(get.headers.get("Content-Length"), String(PNG_1X1.length));
});

test("GET media cache headers differ with a version query", async () => {
  const path = ctx.path("media", "cached.png");
  const created = expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const plain = await request(ctx, "GET", mediaUrl(path));
  const versioned = await request(ctx, "GET", `${mediaUrl(path)}?v=${encodeURIComponent(created.revision)}`);
  assert.equal(versioned.status, 200);
  assert.ok(versioned.bytes.equals(PNG_1X1));
  if (ctx.isMock) {
    assert.equal(plain.headers.get("Cache-Control"), "private, max-age=0, must-revalidate");
    assert.equal(versioned.headers.get("Cache-Control"), "private, max-age=86400");
  } else {
    assert.ok(plain.headers.get("Cache-Control"));
    assert.ok(versioned.headers.get("Cache-Control"));
  }
});

test("GET media with matching If-None-Match returns 304", async () => {
  const path = ctx.path("media", "fresh.png");
  const created = expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const quoted = await request(ctx, "GET", mediaUrl(path), {
    headers: { "If-None-Match": `"${created.revision}"` },
  });
  assert.equal(quoted.status, 304);
  assert.equal(quoted.bytes.length, 0);
  const star = await request(ctx, "GET", mediaUrl(path), {
    headers: { "If-None-Match": "*" },
  });
  assert.equal(star.status, 304);
});

test("GET media single Range returns 206 with the exact slice", async () => {
  const path = ctx.path("media", "range.png");
  expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const resp = await request(ctx, "GET", mediaUrl(path), {
    headers: { Range: "bytes=0-7" },
  });
  if (ctx.isMock) {
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get("Content-Range"), `bytes 0-7/${PNG_1X1.length}`);
    assert.ok(resp.bytes.equals(PNG_SIGNATURE));
  } else {
    // Range support is SHOULD: a backend may answer 200 with full bytes.
    if (resp.status === 206) {
      assert.ok(resp.bytes.equals(PNG_SIGNATURE));
    } else {
      assert.equal(resp.status, 200);
      assert.ok(resp.bytes.equals(PNG_1X1));
    }
  }
});

test("GET media suffix Range returns the tail bytes", async () => {
  const path = ctx.path("media", "suffix.png");
  expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const resp = await request(ctx, "GET", mediaUrl(path), {
    headers: { Range: "bytes=-8" },
  });
  if (ctx.isMock) {
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get("Content-Range"), `bytes ${PNG_1X1.length - 8}-${PNG_1X1.length - 1}/${PNG_1X1.length}`);
    assert.ok(resp.bytes.equals(PNG_1X1.subarray(PNG_1X1.length - 8)));
  } else if (resp.status === 206) {
    assert.ok(resp.bytes.equals(PNG_1X1.subarray(PNG_1X1.length - 8)));
  } else {
    assert.equal(resp.status, 200);
    assert.ok(resp.bytes.equals(PNG_1X1));
  }
});

test("GET media unsatisfiable Range returns 416", async () => {
  const path = ctx.path("media", "oor.png");
  expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const resp = await request(ctx, "GET", mediaUrl(path), {
    headers: { Range: `bytes=${PNG_1X1.length + 100}-${PNG_1X1.length + 200}` },
  });
  if (ctx.isMock) {
    expectError(resp, 416, "range_not_satisfiable");
    assert.equal(resp.headers.get("Content-Range"), `bytes */${PNG_1X1.length}`);
  } else if (resp.status === 416) {
    expectError(resp, 416, "range_not_satisfiable");
  } else {
    assert.equal(resp.status, 200);
    assert.ok(resp.bytes.equals(PNG_1X1));
  }
});

test("GET media errors: missing 404, folder 404, empty remainder 400", async () => {
  const missing = await request(ctx, "GET", mediaUrl(ctx.path("media", "ghost.png")));
  expectError(missing, 404, "not_found");
  const folder = ctx.path("media", "mediadir");
  await mkdirOk(ctx, folder);
  const dir = await request(ctx, "GET", mediaUrl(folder));
  expectError(dir, 404, "not_found");
  const empty = await request(ctx, "GET", "/api/workspace/media/");
  expectError(empty, 400, "invalid_path");
});

test("GET media of a hidden path returns 404", skipUnlessMock(ctx, "hidden fixture cannot be planted via the API"), async () => {
  const hiddenPath = ctx.path(".secret", "h.png");
  ctx.store.injectFile(hiddenPath, PNG_1X1);
  const resp = await request(ctx, "GET", mediaUrl(hiddenPath));
  expectError(resp, 404, "not_found");
});

test("GET media of a text file uses attachment disposition without CSP sandbox", async () => {
  const path = ctx.path("media", "doc.txt");
  await createFile(ctx, path, "plain text");
  const get = await request(ctx, "GET", mediaUrl(path));
  assert.equal(get.status, 200);
  assert.equal(get.text, "plain text");
  assert.equal(get.headers.get("Content-Type"), "text/plain");
  assert.ok(get.headers.get("Content-Disposition").startsWith("attachment"));
  assert.equal(get.headers.get("Content-Security-Policy"), null);
});

test("HEAD media returns GET headers without a body", async () => {
  const path = ctx.path("media", "head.png");
  const created = expectOk(await putMedia(path, PNG_1X1, { "If-None-Match": "*" }), 201, "PUT media create");
  const head = await request(ctx, "HEAD", mediaUrl(path));
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.get("Content-Type"), "image/png");
  assert.equal(head.headers.get("ETag"), `"${created.revision}"`);
  assert.equal(head.headers.get("Content-Disposition"), "inline");
  assert.equal(head.headers.get("X-Content-Type-Options"), "nosniff");
});

test("HEAD media missing returns 404 without a body", async () => {
  const head = await request(ctx, "HEAD", mediaUrl(ctx.path("media", "nope.png")));
  assert.equal(head.status, 404);
  assert.equal(head.bytes.length, 0);
});

test("POST multipart creates a PNG via the ifNoneMatch field", async () => {
  const path = ctx.path("media", "multi.png");
  const resp = await postMultipart([
    { name: "path", data: path },
    { name: "ifNoneMatch", data: "*" },
    { name: "file", filename: "multi.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  const data = expectOk(resp, 201, "POST multipart create");
  assertMediaShape(data, path, PNG_1X1.length);
  assert.equal(data.mimeType, "image/png");
  assert.equal(data.disposition, "inline");
  const get = await request(ctx, "GET", mediaUrl(path));
  assert.ok(get.bytes.equals(PNG_1X1));
});

test("POST multipart overwrite via the ifMatch field, stale field returns 412", async () => {
  const path = ctx.path("media", "multi-over.png");
  const created = expectOk(
    await postMultipart([
      { name: "path", data: path },
      { name: "ifNoneMatch", data: "*" },
      { name: "file", filename: "multi-over.png", contentType: "image/png", data: PNG_1X1 },
    ]),
    201,
    "POST multipart create",
  );
  const stale = await postMultipart([
    { name: "path", data: path },
    { name: "ifMatch", data: "sha256:stale" },
    { name: "file", filename: "multi-over.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  const error = expectError(stale, 412, "revision_conflict");
  assertConflictDetails(error, path);
  const ok = await postMultipart([
    { name: "path", data: path },
    { name: "ifMatch", data: `"${created.revision}"` },
    { name: "file", filename: "multi-over.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  assert.equal(expectOk(ok, 200, "POST multipart overwrite").version, 2);
});

test("POST multipart accepts a header guard and agreeing header plus field guards", async () => {
  const viaHeader = ctx.path("media", "via-header.png");
  const first = await postMultipart(
    [
      { name: "path", data: viaHeader },
      { name: "file", filename: "via-header.png", contentType: "image/png", data: PNG_1X1 },
    ],
    { "If-None-Match": "*" },
  );
  expectOk(first, 201, "POST multipart header guard");
  const revision = expectOk(
    await request(ctx, "GET", `/api/workspace/stat${query({ path: viaHeader })}`),
    200,
    "stat for revision",
  ).revision;
  const agreeing = await postMultipart(
    [
      { name: "path", data: viaHeader },
      { name: "ifMatch", data: `"${revision}"` },
      { name: "file", filename: "via-header.png", contentType: "image/png", data: PNG_1X1 },
    ],
    { "If-Match": `"${revision}"` },
  );
  assert.equal(expectOk(agreeing, 200, "POST multipart agreeing guards").version, 2);
  const disagreeing = await postMultipart(
    [
      { name: "path", data: viaHeader },
      { name: "ifMatch", data: "sha256:other" },
      { name: "file", filename: "via-header.png", contentType: "image/png", data: PNG_1X1 },
    ],
    { "If-Match": `"${revision}"` },
  );
  expectError(disagreeing, 400, "invalid_precondition");
});

test("POST multipart without a guard returns 428", async () => {
  const resp = await postMultipart([
    { name: "path", data: ctx.path("media", "noguard-multi.png") },
    { name: "file", filename: "noguard-multi.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  expectError(resp, 428, "precondition_required");
});

test("POST multipart guard field misuse returns 400 invalid_precondition", async () => {
  const base = (extra) => [
    { name: "path", data: ctx.path("media", "guard-misuse.png") },
    ...extra,
    { name: "file", filename: "guard-misuse.png", contentType: "image/png", data: PNG_1X1 },
  ];
  const both = await postMultipart(base([
    { name: "ifMatch", data: "sha256:abc" },
    { name: "ifNoneMatch", data: "*" },
  ]));
  expectError(both, 400, "invalid_precondition");
  const nonStar = await postMultipart(base([{ name: "ifNoneMatch", data: "sha256:abc" }]));
  expectError(nonStar, 400, "invalid_precondition");
  const dup = await postMultipart(base([
    { name: "ifMatch", data: "sha256:abc" },
    { name: "ifMatch", data: "sha256:def" },
  ]));
  expectError(dup, 400, "invalid_precondition");
});

test("POST multipart rejects non-multipart and malformed uploads with 400", async () => {
  const json = await request(ctx, "POST", "/api/workspace/media", {
    json: { path: ctx.path("media", "json.png") },
  });
  expectError(json, 400, "invalid_upload");
  const noFile = await postMultipart([
    { name: "path", data: ctx.path("media", "nofile.png") },
    { name: "ifNoneMatch", data: "*" },
  ]);
  expectError(noFile, 400, "invalid_upload");
  const twoFiles = await postMultipart([
    { name: "path", data: ctx.path("media", "twofiles.png") },
    { name: "ifNoneMatch", data: "*" },
    { name: "file", filename: "a.png", contentType: "image/png", data: PNG_1X1 },
    { name: "file", filename: "b.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  expectError(twoFiles, 400, "invalid_upload");
  const noPath = await postMultipart([
    { name: "ifNoneMatch", data: "*" },
    { name: "file", filename: "nopath.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  expectError(noPath, 400, "invalid_upload");
  const twoPaths = await postMultipart([
    { name: "path", data: ctx.path("media", "p1.png") },
    { name: "path", data: ctx.path("media", "p2.png") },
    { name: "ifNoneMatch", data: "*" },
    { name: "file", filename: "twopaths.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  expectError(twoPaths, 400, "invalid_upload");
});

test("POST multipart rejects unsupported types and invalid paths", async () => {
  const html = await postMultipart([
    { name: "path", data: ctx.path("media", "multi-html.png") },
    { name: "ifNoneMatch", data: "*" },
    { name: "file", filename: "multi-html.png", contentType: "image/png", data: Buffer.from("<html></html>", "utf8") },
  ]);
  expectError(html, 415, "unsupported_media_type");
  const invalid = await postMultipart([
    { name: "path", data: "../escape.png" },
    { name: "ifNoneMatch", data: "*" },
    { name: "file", filename: "escape.png", contentType: "image/png", data: PNG_1X1 },
  ]);
  expectError(invalid, 400, "invalid_path");
});
