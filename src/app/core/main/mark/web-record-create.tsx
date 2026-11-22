// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Create dialog for the web inbox (Fase 1, V3-26). The five MVP create
// flows from V1-14 section 7.3: text, link, image (paste/upload), file
// (upload), and todo. Recording and scan/OS capture are shown disabled
// with the honest V1-14 section 7.4 copy. Enrichment jobs and the
// clipper do not exist in the MVP and nothing here calls them.
//
// Paste uses the browser Clipboard API on an explicit button press,
// plus the native paste event; the desktop clipboard plugin is never
// touched from this file (D-3D-2: the vendor clipboard package stays
// behind the G3 platform adapter, and web clipboard reads are explicit
// not-implemented stubs there, so the web paste path uses the browser
// API directly and falls back to manual paste with honest copy).

"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildFileCreateBody,
  buildImageCreateBody,
  buildLinkCreateBody,
  buildTextCreateBody,
  buildTodoCreateBody,
  createBodyMatchesRecord,
  makeSourceId,
  type CreateRecordBody,
  type RecordType,
  type TodoPriority,
} from "@/lib/web/record-inputs";
import {
  apiErrorWireCode,
  type ApiRecord,
  type ApiTag,
  type RecordsApiPort,
} from "@/lib/web/records-client";
import { isNoTagsExistError } from "@/lib/web/records-kind-client";
import { TagChecklist } from "./web-inbox-shared";

type CreateFlow = "text" | "link" | "image" | "file" | "todo";

const FLOW_TITLES: Record<CreateFlow, "textTitle" | "linkTitle" | "imageTitle" | "fileTitle" | "todoTitle"> = {
  text: "textTitle",
  link: "linkTitle",
  image: "imageTitle",
  file: "fileTitle",
  todo: "todoTitle",
};

export interface WebRecordCreateProps {
  api: RecordsApiPort;
  tags: ApiTag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecordCreated: (record: ApiRecord) => void;
  initialFlow?: CreateFlow;
}

export function WebRecordCreate({
  api,
  tags,
  open,
  onOpenChange,
  onRecordCreated,
  initialFlow = "text",
}: WebRecordCreateProps) {
  const t = useTranslations("record.mark.inbox.create");
  const tList = useTranslations("record.mark.inbox.list");
  const tTodo = useTranslations("record.mark.todo");
  const tType = useTranslations("record.mark.type");
  const [flow, setFlow] = useState<CreateFlow>(initialFlow);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDescription, setTodoDescription] = useState("");
  const [todoPriority, setTodoPriority] = useState<TodoPriority>("medium");
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // One sourceId per draft: retries of the same save reuse it, so a
  // retry answers duplicate instead of creating a second record.
  const sourceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      setFlow(initialFlow);
      setNotice(null);
      setPasteNote(null);
      sourceIdRef.current = null;
    }
  }, [open, initialFlow]);

  function switchFlow(next: CreateFlow) {
    setFlow(next);
    setNotice(null);
    setPasteNote(null);
    sourceIdRef.current = null;
  }

  function resetDraft() {
    setText("");
    setUrl("");
    setCaption("");
    setTodoTitle("");
    setTodoDescription("");
    setTodoPriority("medium");
    setSelectedTagIds([]);
    setFile(null);
    setNotice(null);
    setPasteNote(null);
    sourceIdRef.current = null;
  }

  function getSourceId(kind: "paste" | "upload", seed: string): string {
    if (sourceIdRef.current === null) {
      sourceIdRef.current = makeSourceId(kind, seed);
    }
    return sourceIdRef.current;
  }

  async function handlePasteText() {
    setPasteNote(null);
    try {
      const pasted = await navigator.clipboard.readText();
      if (pasted !== "") {
        setText((current) => current + pasted);
        setPasteNote(t("pasted"));
      }
    } catch {
      setPasteNote(t("pasteFailed"));
    }
  }

  function handlePasteImage(event: React.ClipboardEvent) {
    const item = Array.from(event.clipboardData?.files ?? []).find((entry) =>
      entry.type.startsWith("image/"),
    );
    if (item) {
      event.preventDefault();
      setFile(item);
    }
  }

  function reportSaveError(error: unknown) {
    if (apiErrorWireCode(error) === "unauthenticated") {
      setNotice(tList("sessionExpired"));
    } else if (isNoTagsExistError(error)) {
      setNotice(t("noTagsExist"));
    } else {
      setNotice(t("saveFailed"));
    }
  }

  async function handleSave() {
    setBusy(true);
    setNotice(null);
    try {
      const selection = { tagIds: selectedTagIds };
      let created: ApiRecord;
      let sentBody: CreateRecordBody | null = null;
      if (flow === "text") {
        let body;
        try {
          body = buildTextCreateBody(text, selection, getSourceId("paste", text));
        } catch {
          setNotice(t("emptyText"));
          return;
        }
        sentBody = body;
        created = await api.createRecord(body);
      } else if (flow === "link") {
        let body;
        try {
          body = buildLinkCreateBody(url, selection, getSourceId("paste", url));
        } catch {
          setNotice(t("invalidUrl"));
          return;
        }
        sentBody = body;
        created = await api.createRecord(body);
      } else if (flow === "todo") {
        let body;
        try {
          body = buildTodoCreateBody(
            {
              title: todoTitle,
              description: todoDescription,
              priority: todoPriority,
            },
            selection,
            getSourceId("paste", todoTitle),
          );
        } catch {
          setNotice(t("emptyText"));
          return;
        }
        sentBody = body;
        created = await api.createRecord(body);
      } else {
        if (file === null) {
          setNotice(t("noFile"));
          return;
        }
        const uploaded = await api.uploadAsset(file, file.name);
        const seed = `${file.name}:${file.size}`;
        const body =
          flow === "image"
            ? buildImageCreateBody(
                uploaded.assetKey,
                caption,
                selection,
                getSourceId("upload", seed),
              )
            : buildFileCreateBody(
                uploaded.assetKey,
                uploaded.fileName,
                caption === "" ? undefined : caption,
                selection,
                getSourceId("upload", seed),
              );
        sentBody = body;
        created = await api.createRecord(body);
      }
      if (
        created.duplicate === true &&
        sentBody !== null &&
        !createBodyMatchesRecord(sentBody, created)
      ) {
        // F02-09: the first save committed but its response was
        // lost, and the draft was edited since. The server kept
        // the first version; do not close as success and drop the
        // edits. A fresh sourceId lets the next save create a new
        // record with the edited content.
        sourceIdRef.current = null;
        setNotice(t("duplicateDraft"));
        return;
      }
      resetDraft();
      onRecordCreated(created);
      onOpenChange(false);
    } catch (error) {
      reportSaveError(error);
    } finally {
      setBusy(false);
    }
  }

  const flowButtons: Array<{ flow: CreateFlow; type: RecordType }> = [
    { flow: "text", type: "text" },
    { flow: "link", type: "link" },
    { flow: "image", type: "image" },
    { flow: "file", type: "file" },
    { flow: "todo", type: "todo" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetDraft();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(FLOW_TITLES[flow])}</DialogTitle>
          <DialogDescription>{t("title")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {flowButtons.map(({ flow: candidate, type }) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={flow === candidate ? "default" : "outline"}
              disabled={busy}
              onClick={() => switchFlow(candidate)}
            >
              {tType(type)}
            </Button>
          ))}
        </div>

        <div className="space-y-1 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled>
              {tType("recording")}
            </Button>
            <span className="text-xs text-zinc-500">
              {t("notAvailable")} {t("recordingReason")}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled>
              {tType("scan")}
            </Button>
            <span className="text-xs text-zinc-500">
              {t("notAvailable")} {t("scanReason")}
            </span>
          </div>
        </div>

        {notice && (
          <p role="alert" className="text-sm text-red-600">
            {notice}
          </p>
        )}

        {flow === "text" && (
          <div className="space-y-2">
            <Textarea
              aria-label={t("textTitle")}
              placeholder={t("textPlaceholder")}
              value={text}
              rows={6}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={handlePasteText}
              >
                {t("pasteButton")}
              </Button>
              {pasteNote && (
                <span className="text-xs text-zinc-500">{pasteNote}</span>
              )}
            </div>
          </div>
        )}

        {flow === "link" && (
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="inbox-create-url">{t("urlLabel")}</Label>
              <Input
                id="inbox-create-url"
                value={url}
                placeholder={t("urlPlaceholder")}
                disabled={busy}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <p className="text-sm text-zinc-500">{t("linkNotice")}</p>
          </div>
        )}

        {(flow === "image" || flow === "file") && (
          <div className="space-y-2" onPaste={flow === "image" ? handlePasteImage : undefined}>
            <input
              ref={fileInputRef}
              type="file"
              accept={flow === "image" ? "image/*" : undefined}
              className="hidden"
              aria-label={flow === "image" ? t("chooseImage") : t("chooseFile")}
              onChange={(event) =>
                setFile(event.target.files?.[0] ?? null)
              }
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {flow === "image" ? t("chooseImage") : t("chooseFile")}
              </Button>
              {file && <span className="truncate text-sm">{file.name}</span>}
            </div>
            {file && (
              <p className="text-sm text-zinc-500">
                {flow === "image" ? t("imageNotice") : t("fileNotice")}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="inbox-create-caption">
                {flow === "image"
                  ? t("imageCaptionLabel")
                  : t("fileCaptionLabel")}
              </Label>
              <Input
                id="inbox-create-caption"
                value={caption}
                disabled={busy}
                onChange={(event) => setCaption(event.target.value)}
              />
            </div>
          </div>
        )}

        {flow === "todo" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="inbox-create-todo-title">
                {tTodo("title")}
              </Label>
              <Input
                id="inbox-create-todo-title"
                value={todoTitle}
                placeholder={tTodo("titlePlaceholder")}
                disabled={busy}
                onChange={(event) => setTodoTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="inbox-create-todo-desc">
                {tTodo("description")}
              </Label>
              <Textarea
                id="inbox-create-todo-desc"
                value={todoDescription}
                placeholder={tTodo("descriptionPlaceholder")}
                disabled={busy}
                onChange={(event) => setTodoDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{tTodo("priority")}</Label>
              <div className="flex gap-2">
                {(
                  [
                    ["low", tTodo("priorityLow")],
                    ["medium", tTodo("priorityMedium")],
                    ["high", tTodo("priorityHigh")],
                  ] as Array<[TodoPriority, string]>
                ).map(([priority, label]) => (
                  <Button
                    key={priority}
                    type="button"
                    size="sm"
                    variant={todoPriority === priority ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => setTodoPriority(priority)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <Label>{t("tagsLabel")}</Label>
          <TagChecklist
            tags={tags}
            selected={selectedTagIds}
            onChange={setSelectedTagIds}
            disabled={busy}
          />
        </div>

        <div className="flex gap-2 border-t pt-3">
          <Button disabled={busy} onClick={handleSave}>
            {busy ? t("saving") : t("save")}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
