// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Web inbox parent (Fase 1, wave 4, W4-CODEMOD): mounts the V3-26
// cluster (WebTagSidebar, WebInboxList, WebRecordCreate,
// WebRecordDetail) as the notes tab body and owns every
// RecordsApiPort call the cluster needs: tag/record loading with
// cursor pagination, view and tag filtering, selection actions
// through the sequential helpers (contract 3.8: no bulk endpoint),
// single-record trash toggling, and the create/detail dialogs.
//
// RecordsApiPort selection: KindRecordsApi over platform.sql, with
// the REST RecordsApi singleton as the asset uploader only (POST
// /api/assets exists, contract 3.7). D-3D-1 re-verified for this
// mounting: the REST /api/marks and /api/tags routes still do not
// exist on this trunk, so the kind path is the only live data path
// and the REST client cannot serve the mounted UI. When the REST
// routes land, the switch is this file's api construction alone;
// the children depend on the port, never on a transport. The
// S5-Q7 decision (mounting plus port selection) belongs to the
// integrator; this file is the worker's proposal in code.
//
// Honest limits, all inherited from the kind path and the port:
// - Empty trash has no kind and no mounted control: KindRecordsApi
//   throws capability_unavailable, and no child calls it. Wiring
//   an empty-trash button waits on a kind or the REST route.
// - Trash lists never combine with a tag filter (contract A-12,
//   enforced by the kind client); selecting trash ignores the
//   selected tag until the active view returns.
// - Text, type, date-range, tag-rule, and non-default-sort filters
//   are unavailable over kinds and are not offered here.
// - The sidebar header actions (MarkActions) are still the
//   upstream mark-store controls and are not wired to this inbox;
//   their replacement is follow-up work, recorded in the wave 4
//   report. The inbox itself is fully usable without them: the
//   New record entry point lives in the header below.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform";
import { ApiError } from "@/lib/web/errors";
import { KindRecordsApi } from "@/lib/web/records-kind-client";
import {
  deleteRecordsPermanentSequential,
  moveRecordsTagsSequential,
  recordsApi,
  restoreRecordsSequential,
  softDeleteRecordsSequential,
  type ApiRecord,
  type ApiTag,
  type RecordsApiPort,
  type SequentialResult,
} from "@/lib/web/records-client";
import emitter from "@/lib/emitter";
import { EmitterRecordEvents } from "@/config/emitters";
import { WebInboxList, type InboxLoadError, type SelectionAction } from "./web-inbox-list";
import { WebRecordCreate } from "./web-record-create";
import { WebRecordDetail } from "./web-record-detail";
import { WebTagSidebar, type InboxView } from "./web-tag-sidebar";

const PAGE_LIMIT = 50;

export interface WebInboxProps {
  /** Override for tests. Production constructs KindRecordsApi. */
  api?: RecordsApiPort;
}

function isSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function WebInbox({ api: apiOverride }: WebInboxProps) {
  const tList = useTranslations("record.mark.inbox.list");
  const tCreate = useTranslations("record.mark.inbox.create");
  const api = useMemo<RecordsApiPort>(
    () =>
      apiOverride ??
      new KindRecordsApi({ sql: platform.sql, assets: recordsApi }),
    [apiOverride],
  );
  const [tags, setTags] = useState<ApiTag[]>([]);
  const [view, setView] = useState<InboxView>("active");
  const [selectedTagId, setSelectedTagId] = useState<number | "all">("all");
  const [records, setRecords] = useState<ApiRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<InboxLoadError | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailRecord, setDetailRecord] = useState<ApiRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const loadSeqRef = useRef(0);

  const loadTags = useCallback(async () => {
    const { tags: fresh } = await api.listTags();
    setTags(fresh);
  }, [api]);

  const loadRecords = useCallback(
    async (options: { append: boolean; cursor?: string }) => {
      const seq = ++loadSeqRef.current;
      if (options.append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setLoadError(null);
      try {
        const page = await api.listRecords(
          {
            status: view === "trash" ? "trash" : "active",
            // Trash never combines with a tag filter (A-12).
            ...(view === "trash"
              ? {}
              : selectedTagId === "all"
                ? {}
                : { tagId: selectedTagId }),
            limit: PAGE_LIMIT,
          },
          options.cursor,
        );
        if (loadSeqRef.current !== seq) return;
        setRecords((prev) =>
          options.append ? [...prev, ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (error) {
        if (loadSeqRef.current !== seq) return;
        setLoadError(isSessionError(error) ? "session" : "generic");
      } finally {
        if (loadSeqRef.current === seq) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, view, selectedTagId],
  );

  const reloadAll = useCallback(async () => {
    setActionNotice(null);
    await loadTags().catch(() => {
      // Tag reload failure surfaces on the next record load or the
      // next tag interaction; the record list is the primary view.
    });
    await loadRecords({ append: false });
  }, [loadTags, loadRecords]);

  // UTANG-UJI-01: the upstream MarkActions controls create
  // records through the same marks.create kind and announce it
  // with refreshMarks, but this inbox keeps its own state and
  // never heard the event, so the list and tag counts went
  // stale until a filter change or reload. Reload on the
  // event (same mechanism tag-manage uses). Since BUG-04 this
  // inbox also emits the event after its own mutations so the
  // other record surfaces stay fresh; the listener below only
  // reloads and never emits, so there is no loop.
  useEffect(() => {
    const refresh = () => { void reloadAll() }
    emitter.on(EmitterRecordEvents.refreshMarks, refresh)
    return () => { emitter.off(EmitterRecordEvents.refreshMarks, refresh) }
  }, [reloadAll])

  useEffect(() => {
    void loadTags().catch(() => {
      // Tags load again with the record list below; a tags-only
      // failure leaves the tag filter empty rather than blocking
      // the list.
    });
  }, [loadTags]);

  useEffect(() => {
    setSelectedIds([]);
    void loadRecords({ append: false });
  }, [loadRecords]);

  function handleViewChange(next: InboxView) {
    setView(next);
  }

  function handleSelectTag(tagId: number | "all") {
    setSelectedTagId(tagId);
  }

  // BUG-04: announce inbox mutations on the shared event so
  // tag-manage counts and the mark store stay fresh. Only
  // called after a mutation actually changed records.
  function emitRefreshMarks() {
    emitter.emit(EmitterRecordEvents.refreshMarks);
  }

  async function handleTagsChanged() {
    await reloadAll();
    emitRefreshMarks();
  }

  function handleToggleSelect(id: number, checked: boolean) {
    setSelectedIds((prev) =>
      checked ? [...prev, id] : prev.filter((entry) => entry !== id),
    );
  }

  function handleOpenRecord(record: ApiRecord) {
    setDetailRecord(record);
    setDetailOpen(true);
  }

  function handleLoadMore() {
    if (cursor) void loadRecords({ append: true, cursor });
  }

  function handleRetry() {
    void reloadAll();
  }

  function reportSequential(result: SequentialResult) {
    if (result.failed.length === 0) return;
    setActionNotice(
      result.succeeded.length > 0
        ? tList("movePartial")
        : tList("errorGeneric"),
    );
  }

  async function handleSelectionAction(action: SelectionAction, ids: number[]) {
    setActionNotice(null);
    const result =
      action === "delete"
        ? await softDeleteRecordsSequential(api, ids)
        : action === "restore"
          ? await restoreRecordsSequential(api, ids)
          : await deleteRecordsPermanentSequential(api, ids);
    reportSequential(result);
    setSelectedIds((prev) =>
      prev.filter((id) => !result.succeeded.includes(id)),
    );
    await reloadAll();
    if (result.succeeded.length > 0) emitRefreshMarks();
  }

  async function handleMoveSelected(targetTagId: number, ids: number[]) {
    setActionNotice(null);
    const byId = new Map(records.map((record) => [record.id, record]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((record): record is ApiRecord => record !== undefined)
      .map((record) => ({
        id: record.id,
        // Move adds the target tag to the set the UI loaded
        // (union, UTANG-UJI-02); it never drops the record's
        // other tags. The guard still expects the loaded set.
        tagIds: [...new Set([...record.tagIds, targetTagId])],
        expectedTagIds: record.tagIds,
      }));
    const result = await moveRecordsTagsSequential(api, items);
    reportSequential(result);
    setSelectedIds((prev) =>
      prev.filter((id) => !result.succeeded.includes(id)),
    );
    await reloadAll();
    if (result.succeeded.length > 0) emitRefreshMarks();
  }

  async function handleTrashToggleOne(record: ApiRecord) {
    setActionNotice(null);
    try {
      if (record.deleted) {
        await api.restoreRecord(record.id);
      } else {
        await api.softDeleteRecord(record.id);
      }
    } catch {
      setActionNotice(tList("errorGeneric"));
      return;
    }
    await reloadAll();
    emitRefreshMarks();
  }

  function handleRecordCreated() {
    void reloadAll();
    emitRefreshMarks();
  }

  function handleRecordChanged(record: ApiRecord) {
    setDetailRecord(record);
    setRecords((prev) =>
      prev.map((entry) => (entry.id === record.id ? record : entry)),
    );
    void loadTags();
    emitRefreshMarks();
  }

  function handleRecordDeleted(id: number) {
    setDetailRecord(null);
    setRecords((prev) => prev.filter((entry) => entry.id !== id));
    void loadTags();
    emitRefreshMarks();
  }

  return (
    <div
      id="web-inbox"
      className="flex h-full min-h-0 w-full flex-col"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b p-2">
        <p className="text-sm font-medium">{tList("title")}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          {tCreate("title")}
        </Button>
      </div>
      {actionNotice && (
        <p role="alert" className="shrink-0 border-b p-2 text-sm text-red-600">
          {actionNotice}
        </p>
      )}
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b">
        <WebTagSidebar
          api={api}
          tags={tags}
          view={view}
          selectedTagId={selectedTagId}
          onViewChange={handleViewChange}
          onSelectTag={handleSelectTag}
          onTagsChanged={handleTagsChanged}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <WebInboxList
          records={records}
          tags={tags}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore}
          loadError={loadError}
          filtersActive={selectedTagId !== "all"}
          trashView={view === "trash"}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onClearSelection={() => setSelectedIds([])}
          onOpenRecord={handleOpenRecord}
          onLoadMore={handleLoadMore}
          onRetry={handleRetry}
          onSelectionAction={handleSelectionAction}
          onMoveSelected={handleMoveSelected}
          onTrashToggleOne={handleTrashToggleOne}
        />
      </div>
      <WebRecordCreate
        api={api}
        tags={tags}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onRecordCreated={handleRecordCreated}
      />
      <WebRecordDetail
        api={api}
        record={detailRecord}
        tags={tags}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onRecordChanged={handleRecordChanged}
        onRecordDeleted={handleRecordDeleted}
      />
    </div>
  );
}
