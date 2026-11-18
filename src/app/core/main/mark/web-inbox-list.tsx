// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Inbox record list for the web inbox (Fase 1, V3-26). Presentational:
// the parent owns loading, filters, and all RecordsApiPort calls. Selection
// actions are reported to the parent, which runs the per-record
// sequential helpers (contract 3.8: no bulk endpoint) and reloads.

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { recordDisplayTitle } from "@/lib/web/record-inputs";
import type { ApiRecord, ApiTag } from "@/lib/web/records-client";
import {
  RecordTypeBadge,
  formatRecordDate,
  tagNamesFor,
} from "./web-inbox-shared";

export type InboxLoadError = "session" | "generic";

export type SelectionAction = "delete" | "restore" | "permanent";

export interface WebInboxListProps {
  records: ApiRecord[];
  tags: ApiTag[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadError: InboxLoadError | null;
  filtersActive: boolean;
  trashView: boolean;
  selectedIds: number[];
  onToggleSelect: (id: number, checked: boolean) => void;
  onClearSelection: () => void;
  onOpenRecord: (record: ApiRecord) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelectionAction: (action: SelectionAction, ids: number[]) => void;
  onMoveSelected: (targetTagId: number, ids: number[]) => void;
  onTrashToggleOne: (record: ApiRecord) => void;
}

export function WebInboxList({
  records,
  tags,
  loading,
  loadingMore,
  hasMore,
  loadError,
  filtersActive,
  trashView,
  selectedIds,
  onToggleSelect,
  onClearSelection,
  onOpenRecord,
  onLoadMore,
  onRetry,
  onSelectionAction,
  onMoveSelected,
  onTrashToggleOne,
}: WebInboxListProps) {
  const t = useTranslations("record.mark.inbox.list");
  const [moveTarget, setMoveTarget] = useState<string>("");
  // DA-11-16: bulk permanent delete needs the same explicit
  // confirmation as the single-record dialog in the detail view;
  // a stray click on a large selection must never delete forever.
  const [confirmPermanentSelected, setConfirmPermanentSelected] =
    useState(false);

  if (loading && records.length === 0) {
    return <p className="p-4 text-sm text-zinc-500">{t("loading")}</p>;
  }

  if (loadError !== null && records.length === 0) {
    return (
      <div className="space-y-2 p-4">
        <p role="alert" className="text-sm text-red-600">
          {loadError === "session" ? t("sessionExpired") : t("errorLoading")}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  if (records.length === 0) {
    const emptyCopy = trashView
      ? t("emptyTrash")
      : filtersActive
        ? t("emptyFiltered")
        : t("empty");
    return <p className="p-4 text-sm text-zinc-500">{emptyCopy}</p>;
  }

  const selectedSet = new Set(selectedIds);

  return (
    <>
    <div className="flex min-h-0 flex-1 flex-col">
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b p-2">
          <span className="text-sm text-zinc-600">
            {t("selectedCount", { count: selectedIds.length })}
          </span>
          {!trashView && (
            <>
              <Select value={moveTarget} onValueChange={setMoveTarget}>
                <SelectTrigger
                  className="h-8 w-44"
                  aria-label={t("moveSelected")}
                >
                  <SelectValue placeholder={t("allTags")} />
                </SelectTrigger>
                <SelectContent>
                  {tags.map((tag) => (
                    <SelectItem key={tag.id} value={String(tag.id)}>
                      {tag.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={moveTarget === ""}
                onClick={() =>
                  onMoveSelected(Number(moveTarget), selectedIds)
                }
              >
                {t("moveSelected")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSelectionAction("delete", selectedIds)}
              >
                {t("deleteSelected")}
              </Button>
            </>
          )}
          {trashView && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSelectionAction("restore", selectedIds)}
              >
                {t("restoreSelected")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirmPermanentSelected(true)}
              >
                {t("deleteForeverSelected")}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onClearSelection}>
            {t("clearSelection")}
          </Button>
        </div>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {records.map((record) => {
          const names = tagNamesFor(tags, record.tagIds);
          return (
            <li
              key={record.id}
              className="flex items-start gap-2 border-b px-3 py-2"
            >
              <Checkbox
                id={`inbox-select-${record.id}`}
                checked={selectedSet.has(record.id)}
                onCheckedChange={(value) =>
                  onToggleSelect(record.id, value === true)
                }
                aria-label={recordDisplayTitle(record)}
                className="mt-1"
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onOpenRecord(record)}
              >
                <span className="flex items-center gap-2">
                  <RecordTypeBadge type={record.type} />
                  <span className="truncate text-sm font-medium">
                    {recordDisplayTitle(record)}
                  </span>
                </span>
                <span className="mt-1 block truncate text-xs text-zinc-500">
                  {names.join(", ")}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-400">
                  {formatRecordDate(record.createdAt)}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onTrashToggleOne(record)}
              >
                {record.deleted ? t("restore") : t("delete")}
              </Button>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div className="border-t p-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>

      <AlertDialog
        open={confirmPermanentSelected}
        onOpenChange={setConfirmPermanentSelected}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteForeverSelectedConfirmTitle", {
                count: selectedIds.length,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteForeverSelectedConfirmDescription", {
                count: selectedIds.length,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPermanentSelected(false);
                onSelectionAction("permanent", selectedIds);
              }}
            >
              {t("confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
