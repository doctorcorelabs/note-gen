// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Tag sidebar for the web inbox (Fase 1, V3-26). View switching
// (records/trash), tag filtering, and tag create/rename/delete/pin
// through RecordsApiPort only. Tag names are validated client-side
// (V3-26b, tag-inputs.ts) before any call. Deleting a tag never
// deletes records (contract 3.6, D-03); a tag still in use requires
// a reassign target, and the delete dialog shows how many records
// use the tag. Locked tags offer no rename, delete, or pin control.

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  apiErrorWireCode,
  type ApiTag,
  type RecordsApiPort,
} from "@/lib/web/records-client";
import {
  validateTagName,
  type TagNameProblem,
} from "@/lib/web/tag-inputs";

export type InboxView = "active" | "trash";

export interface WebTagSidebarProps {
  api: RecordsApiPort;
  tags: ApiTag[];
  view: InboxView;
  selectedTagId: number | "all";
  onViewChange: (view: InboxView) => void;
  onSelectTag: (tagId: number | "all") => void;
  onTagsChanged: () => void;
}

export function WebTagSidebar({
  api,
  tags,
  view,
  selectedTagId,
  onViewChange,
  onSelectTag,
  onTagsChanged,
}: WebTagSidebarProps) {
  const t = useTranslations("record.mark.inbox.sidebar");
  const tList = useTranslations("record.mark.inbox.list");
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ApiTag | null>(null);
  const [reassignTo, setReassignTo] = useState<string>("");
  const [needsReassign, setNeedsReassign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleCreateTag() {
    const checked = validateTagName(newName);
    if (!checked.ok) {
      // An empty name stays silent, as before; a name that fails
      // another rule names the problem instead of calling the API.
      if (checked.reason !== "empty") {
        setNotice(tagNameNotice(checked.reason));
      }
      return;
    }
    const name = checked.name;
    setBusy(true);
    setNotice(null);
    try {
      await api.createTag(name);
      setNewName("");
      onTagsChanged();
    } catch (error) {
      setNotice(tagErrorNotice(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(tag: ApiTag) {
    const checked = validateTagName(editingName);
    if (!checked.ok) {
      if (checked.reason === "empty") {
        setEditingId(null);
        return;
      }
      // Keep the editor open so the name can be fixed in place.
      setNotice(tagNameNotice(checked.reason));
      return;
    }
    const name = checked.name;
    if (name === tag.name) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.updateTag(tag.id, { name });
      setEditingId(null);
      onTagsChanged();
    } catch (error) {
      setNotice(tagErrorNotice(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePin(tag: ApiTag) {
    setBusy(true);
    setNotice(null);
    try {
      await api.updateTag(tag.id, { pinned: !tag.pinned });
      onTagsChanged();
    } catch (error) {
      setNotice(tagErrorNotice(error));
    } finally {
      setBusy(false);
    }
  }

  function tagNameNotice(reason: TagNameProblem): string {
    if (reason === "tooLong") return t("tagNameTooLong");
    if (reason === "controlChars") return t("tagNameInvalid");
    return tList("errorGeneric");
  }

  function tagErrorNotice(error: unknown): string {
    const code = apiErrorWireCode(error);
    if (code === "unauthenticated") return tList("sessionExpired");
    if (code === "tag_name_taken") return t("tagNameTaken");
    if (code === "tag_locked") return t("tagLocked");
    return tList("errorGeneric");
  }

  async function handleDelete(tag: ApiTag, reassign?: number) {
    setBusy(true);
    setNotice(null);
    try {
      await api.deleteTag(tag.id, reassign);
      setPendingDelete(null);
      setNeedsReassign(false);
      setReassignTo("");
      if (selectedTagId === tag.id) onSelectTag("all");
      onTagsChanged();
    } catch (error) {
      const code = apiErrorWireCode(error);
      if (code === "tag_in_use") {
        setNeedsReassign(true);
      } else if (code === "capability_unavailable") {
        // The live kind path has no tags.delete handler yet, so
        // delete is honestly unavailable until it lands (V3-25).
        setNotice(t("deleteUnavailable"));
        setPendingDelete(null);
      } else if (code === "unauthenticated") {
        setNotice(tList("sessionExpired"));
        setPendingDelete(null);
      } else {
        setNotice(tList("errorGeneric"));
        setPendingDelete(null);
      }
    } finally {
      setBusy(false);
    }
  }

  function openDelete(tag: ApiTag) {
    setPendingDelete(tag);
    setNeedsReassign(false);
    setReassignTo("");
  }

  const reassignOptions = pendingDelete
    ? tags.filter((tag) => tag.id !== pendingDelete.id)
    : [];

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <Button
          size="sm"
          variant={view === "active" ? "default" : "ghost"}
          className="justify-start"
          onClick={() => onViewChange("active")}
        >
          {t("allRecords")}
        </Button>
        <Button
          size="sm"
          variant={view === "trash" ? "default" : "ghost"}
          className="justify-start"
          onClick={() => onViewChange("trash")}
        >
          {t("trash")}
        </Button>
      </div>

      <div className="space-y-2 border-t pt-3">
        <p className="text-sm font-medium">{t("tags")}</p>
        {notice && (
          <p role="alert" className="text-sm text-red-600">
            {notice}
          </p>
        )}
        <Button
          size="sm"
          variant={selectedTagId === "all" ? "default" : "ghost"}
          className="w-full justify-start"
          onClick={() => onSelectTag("all")}
        >
          {t("allRecords")}
        </Button>
        <ul className="space-y-1">
          {tags.map((tag) => (
            <li key={tag.id} className="space-y-1">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={
                    selectedTagId === tag.id ? "default" : "ghost"
                  }
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => onSelectTag(tag.id)}
                >
                  <span className="truncate">{tag.name}</span>
                  <span className="ml-auto text-xs text-zinc-500">
                    {tag.recordCount}
                  </span>
                </Button>
                {!tag.locked && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => handleTogglePin(tag)}
                    >
                      {tag.pinned ? t("unpinTag") : t("pinTag")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(tag.id);
                        setEditingName(tag.name);
                      }}
                    >
                      {t("renameTag")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => openDelete(tag)}
                    >
                      {t("deleteTag")}
                    </Button>
                  </>
                )}
              </div>
              {editingId === tag.id && (
                <div className="flex gap-1 pl-2">
                  <Input
                    value={editingName}
                    placeholder={t("renamePlaceholder")}
                    disabled={busy}
                    onChange={(event) =>
                      setEditingName(event.target.value)
                    }
                  />
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => handleRename(tag)}
                  >
                    {t("renameTag")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2 border-t pt-3">
        <Label htmlFor="inbox-new-tag">{t("newTag")}</Label>
        <div className="flex gap-1">
          <Input
            id="inbox-new-tag"
            value={newName}
            placeholder={t("newTagPlaceholder")}
            disabled={busy}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button size="sm" disabled={busy} onClick={handleCreateTag}>
            {t("createTag")}
          </Button>
        </div>
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteTagConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteTagConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDelete && (
            <p className="text-sm text-zinc-600">
              {t("deleteTagAffected", {
                count: pendingDelete.recordCount,
              })}
            </p>
          )}
          {needsReassign && (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-red-600">
                {t("tagInUse")}
              </p>
              <Label htmlFor="inbox-reassign">{t("reassignLabel")}</Label>
              <Select value={reassignTo} onValueChange={setReassignTo}>
                <SelectTrigger id="inbox-reassign">
                  <SelectValue placeholder={t("reassignLabel")} />
                </SelectTrigger>
                <SelectContent>
                  {reassignOptions.map((tag) => (
                    <SelectItem key={tag.id} value={String(tag.id)}>
                      {tag.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{tList("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || (needsReassign && reassignTo === "")}
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) {
                  void handleDelete(
                    pendingDelete,
                    needsReassign ? Number(reassignTo) : undefined,
                  );
                }
              }}
            >
              {tList("confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
