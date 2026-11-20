// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Record detail dialog for the web inbox (Fase 1, V3-26). Reads and
// writes through RecordsApiPort only: content edits carry the optimistic
// version guard, tag edits carry the tag-set guard, and conflicts
// reload the record instead of overwriting silently. Records whose
// content would come from an enrichment job show the V1-14 section
// 7.4 copy when the content is still empty.

"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildTodoContent,
  hasNoExtractedContent,
  parseTodoContent,
  recordAssetUrl,
  recordDisplayTitle,
  type TodoPriority,
} from "@/lib/web/record-inputs";
import {
  apiErrorWireCode,
  type ApiRecord,
  type ApiTag,
  type RecordsApiPort,
} from "@/lib/web/records-client";
import {
  RecordTypeBadge,
  TagChecklist,
  formatRecordDate,
} from "./web-inbox-shared";
import { isHttpUrl } from "@/lib/utils";

export interface WebRecordDetailProps {
  api: RecordsApiPort;
  record: ApiRecord | null;
  tags: ApiTag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecordChanged: (record: ApiRecord) => void;
  onRecordDeleted: (id: number) => void;
}

export function WebRecordDetail({
  api,
  record,
  tags,
  open,
  onOpenChange,
  onRecordChanged,
  onRecordDeleted,
}: WebRecordDetailProps) {
  const t = useTranslations("record.mark.inbox.detail");
  const tList = useTranslations("record.mark.inbox.list");
  const tTodo = useTranslations("record.mark.todo");
  const [current, setCurrent] = useState<ApiRecord | null>(record);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDescription, setTodoDescription] = useState("");
  const [todoPriority, setTodoPriority] = useState<TodoPriority>("medium");
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  // DA-11-12: the parent hands this dialog a new record object on
  // every change (tag save, conflict reload). Resetting the edit
  // draft on object identity discarded in-progress edits, so the
  // full reset runs only when a different record arrives or the
  // dialog opens fresh; same-record updates refresh the
  // guard-bearing snapshot and leave drafts, notices, and the
  // confirm dialog alone.
  const lastDetailRecordIdRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const opened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    const recordId = record ? record.id : null;
    const switched = recordId !== lastDetailRecordIdRef.current;
    lastDetailRecordIdRef.current = recordId;
    if (opened || switched) {
      setCurrent(record);
      setEditing(false);
      setNotice(null);
      setConfirmPermanent(false);
      if (record) {
        setEditText(record.content);
        setSelectedTagIds(record.tagIds);
        const todo = parseTodoContent(record.content, record.desc);
        setTodoTitle(todo.title);
        setTodoDescription(todo.description);
        setTodoPriority(todo.priority);
      }
      return;
    }
    if (record) {
      // Same record, new identity: adopt the fresher snapshot so
      // the next save guards on the current version, but never
      // downgrade to an older snapshot the parent still holds.
      setCurrent((prev) => {
        if (!prev || prev.id !== record.id) return record;
        return record.version >= prev.version ? record : prev;
      });
    }
  }, [record, open]);

  if (!current) return null;

  const tagsChanged =
    selectedTagIds.length !== current.tagIds.length ||
    selectedTagIds.some((id) => !current.tagIds.includes(id));
  const showNoContent = hasNoExtractedContent(current);
  const todo = parseTodoContent(current.content, current.desc);

  async function reload(syncTags = false) {
    try {
      const fresh = await api.getRecord(current!.id);
      setCurrent(fresh);
      onRecordChanged(fresh);
      // DA-11-12: a post-conflict reload must not discard drafts.
      // Tag selection syncs only after a tag conflict (syncTags)
      // or when the user has no unsaved tag change; the text and
      // todo drafts survive whenever the user is editing, and the
      // next save guards on the fresh version above.
      if (syncTags || !tagsChanged) {
        setSelectedTagIds(fresh.tagIds);
      }
      if (!editing) {
        setEditText(fresh.content);
        const todo = parseTodoContent(fresh.content, fresh.desc);
        setTodoTitle(todo.title);
        setTodoDescription(todo.description);
        setTodoPriority(todo.priority);
      }
      return fresh;
    } catch {
      setNotice(t("notFound"));
      return null;
    }
  }

  async function handleSaveEdit() {
    setBusy(true);
    setNotice(null);
    try {
      let body: { content: string; desc: string; expectedVersion: number };
      if (current!.type === "todo") {
        const content = buildTodoContent({
          title: todoTitle,
          description: todoDescription,
          priority: todoPriority,
          completed: todo.completed,
        });
        body = { content, desc: todoTitle.trim(), expectedVersion: current!.version };
      } else {
        body = {
          content: editText,
          desc: editText,
          expectedVersion: current!.version,
        };
      }
      const updated = await api.updateRecord(current!.id, body);
      setCurrent(updated);
      onRecordChanged(updated);
      setEditing(false);
    } catch (error) {
      if (apiErrorWireCode(error) === "revision_conflict") {
        setNotice(t("editConflict"));
        await reload();
      } else {
        setNotice(tList("errorGeneric"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleTodo(completed: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const content = buildTodoContent({ ...todo, completed });
      const updated = await api.updateRecord(current!.id, {
        content,
        desc: todo.title,
        expectedVersion: current!.version,
      });
      setCurrent(updated);
      onRecordChanged(updated);
    } catch (error) {
      if (apiErrorWireCode(error) === "revision_conflict") {
        setNotice(t("editConflict"));
        await reload();
      } else {
        setNotice(tList("errorGeneric"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveTags() {
    setBusy(true);
    setNotice(null);
    try {
      const updated = await api.updateRecordTags(current!.id, {
        tagIds: selectedTagIds,
        expectedTagIds: current!.tagIds,
      });
      setCurrent(updated);
      onRecordChanged(updated);
    } catch (error) {
      if (apiErrorWireCode(error) === "record_tags_changed") {
        setNotice(t("tagsConflict"));
        await reload(true);
      } else {
        setNotice(tList("errorGeneric"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleTrashToggle() {
    setBusy(true);
    setNotice(null);
    try {
      const updated = current!.deleted
        ? await api.restoreRecord(current!.id)
        : await api.softDeleteRecord(current!.id);
      setCurrent(updated);
      onRecordChanged(updated);
    } catch (error) {
      setNotice(
        apiErrorWireCode(error) === "not_found"
          ? t("notFound")
          : tList("errorGeneric"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteForever() {
    setBusy(true);
    try {
      await api.deleteRecordPermanent(current!.id);
      setConfirmPermanent(false);
      onRecordDeleted(current!.id);
      onOpenChange(false);
    } catch {
      setNotice(tList("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const assetSrc =
    current.thumbnailUrl ?? recordAssetUrl(current.url);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RecordTypeBadge type={current.type} />
              <span className="truncate">
                {recordDisplayTitle(current) || t("notFound")}
              </span>
            </DialogTitle>
            <DialogDescription>
              {formatRecordDate(current.createdAt)}
            </DialogDescription>
          </DialogHeader>

          {notice && (
            <p role="alert" className="text-sm text-red-600">
              {notice}
            </p>
          )}

          {showNoContent && (
            <p className="text-sm text-zinc-500">
              {t("noExtractedContent")}
            </p>
          )}

          {current.type === "image" && current.url !== "" && (
            <img
              src={assetSrc}
              alt={current.desc}
              className="max-h-96 w-full rounded object-contain bg-zinc-100"
            />
          )}

          {current.type === "link" && (
            <p className="break-all text-sm">
              {/* A stored non-http(s) url renders as inert text, never an anchor. */}
              {isHttpUrl(current.url) ? (
                <a
                  href={current.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 underline"
                >
                  {t("openLink")}: {current.url}
                </a>
              ) : (
                <span>
                  {t("openLink")}: {current.url}
                </span>
              )}
            </p>
          )}

          {current.type === "file" && (
            <p className="text-sm">
              <a
                href={recordAssetUrl(current.url)}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 underline"
              >
                {t("viewAsset")}
                {current.fileName ? `: ${current.fileName}` : ""}
              </a>
            </p>
          )}

          {current.type === "todo" && !editing && (
            <div className="flex items-start gap-2">
              <Checkbox
                id="inbox-todo-completed"
                checked={todo.completed}
                disabled={busy}
                onCheckedChange={(value) =>
                  handleToggleTodo(value === true)
                }
              />
              <div>
                <Label
                  htmlFor="inbox-todo-completed"
                  className="cursor-pointer"
                >
                  {todo.title}
                </Label>
                {todo.description !== "" && (
                  <p className="whitespace-pre-wrap text-sm text-zinc-600">
                    {todo.description}
                  </p>
                )}
                <p className="text-xs text-zinc-500">
                  {tTodo("priority")}: {tTodo(`priority${todo.priority[0].toUpperCase()}${todo.priority.slice(1)}` as never)}
                </p>
              </div>
            </div>
          )}

          {current.type === "text" && !editing && (
            <p className="whitespace-pre-wrap text-sm">{current.content}</p>
          )}

          {(current.type === "link" ||
            current.type === "image" ||
            current.type === "file") &&
            current.content !== "" && (
              <p className="whitespace-pre-wrap text-sm">{current.content}</p>
            )}

          {editing && current.type === "todo" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="inbox-todo-title">{tTodo("title")}</Label>
                <Input
                  id="inbox-todo-title"
                  value={todoTitle}
                  onChange={(event) => setTodoTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="inbox-todo-desc">
                  {tTodo("description")}
                </Label>
                <Textarea
                  id="inbox-todo-desc"
                  value={todoDescription}
                  onChange={(event) =>
                    setTodoDescription(event.target.value)
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>{tTodo("priority")}</Label>
                <div className="flex gap-2">
                  {(["low", "medium", "high"] as TodoPriority[]).map(
                    (priority) => (
                      <Button
                        key={priority}
                        type="button"
                        size="sm"
                        variant={
                          todoPriority === priority
                            ? "default"
                            : "outline"
                        }
                        onClick={() => setTodoPriority(priority)}
                      >
                        {tTodo(`priority${priority[0].toUpperCase()}${priority.slice(1)}` as never)}
                      </Button>
                    ),
                  )}
                </div>
              </div>
            </div>
          )}

          {editing && current.type === "text" && (
            <Textarea
              aria-label={t("edit")}
              value={editText}
              rows={8}
              onChange={(event) => setEditText(event.target.value)}
            />
          )}

          <div className="space-y-2 border-t pt-3">
            <Label>{t("tagsLabel")}</Label>
            <TagChecklist
              tags={tags}
              selected={selectedTagIds}
              onChange={setSelectedTagIds}
              disabled={busy}
              lockedIds={[current.tagId]}
            />
            {tagsChanged && (
              <Button size="sm" disabled={busy} onClick={handleSaveTags}>
                {t("saveTags")}
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-2 border-t pt-3">
            {(current.type === "text" || current.type === "todo") &&
              !editing && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  {t("edit")}
                </Button>
              )}
            {editing && (
              <>
                <Button size="sm" disabled={busy} onClick={handleSaveEdit}>
                  {t("saveEdit")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  {tList("cancel")}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={handleTrashToggle}
            >
              {current.deleted ? t("restore") : t("delete")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirmPermanent(true)}
            >
              {t("deleteForever")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmPermanent}
        onOpenChange={setConfirmPermanent}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tList("deleteForeverConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tList("deleteForeverConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tList("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteForever}>
              {tList("confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
