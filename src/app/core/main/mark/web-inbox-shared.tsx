// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Shared presentational pieces for the web inbox (Fase 1, V3-26).
// No data fetching here: parents own the RecordsApi calls.

"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ApiTag } from "@/lib/web/records-client";
import type { RecordType } from "@/lib/web/record-inputs";

export function RecordTypeBadge({ type }: { type: RecordType }) {
  const t = useTranslations("record.mark.type");
  return <Badge variant="secondary">{t(type)}</Badge>;
}

export function formatRecordDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

export interface TagChecklistProps {
  tags: ApiTag[];
  selected: number[];
  onChange: (selected: number[]) => void;
  disabled?: boolean;
  /** Tag ids that cannot be unchecked (for example the primary tag). */
  lockedIds?: number[];
}

export function TagChecklist({
  tags,
  selected,
  onChange,
  disabled = false,
  lockedIds = [],
}: TagChecklistProps) {
  function toggle(tagId: number, checked: boolean) {
    if (checked) {
      onChange([...selected, tagId]);
    } else {
      onChange(selected.filter((id) => id !== tagId));
    }
  }
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {tags.map((tag) => {
        const checked = selected.includes(tag.id);
        const locked = lockedIds.includes(tag.id);
        return (
          <span key={tag.id} className="flex items-center gap-1.5">
            <Checkbox
              id={`inbox-tag-${tag.id}`}
              checked={checked}
              disabled={disabled || locked}
              onCheckedChange={(value) => toggle(tag.id, value === true)}
            />
            <Label
              htmlFor={`inbox-tag-${tag.id}`}
              className="cursor-pointer text-sm font-normal"
            >
              {tag.name}
            </Label>
          </span>
        );
      })}
    </div>
  );
}

export function tagNamesFor(
  tags: ApiTag[],
  tagIds: number[],
): string[] {
  const byId = new Map(tags.map((tag) => [tag.id, tag.name]));
  return tagIds.map((id) => byId.get(id) ?? `#${id}`);
}
