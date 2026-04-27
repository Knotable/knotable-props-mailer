"use client";

import { useState, useRef } from "react";

type ListInfo = {
  id: string;
  name: string;
  address: string;
  memberEmails: string[];
};

function RecipientBadge({ list }: { list: ListInfo }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={ref}
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="inline-block text-xs bg-slate-100 text-slate-600 rounded px-2 py-0.5 cursor-default hover:bg-slate-200 transition-colors">
        {list.name}
        {list.memberEmails.length > 0 && (
          <span className="ml-1 text-slate-400">({list.memberEmails.length})</span>
        )}
      </span>
      {open && list.memberEmails.length > 0 && (
        <span className="absolute z-50 left-0 top-full mt-1 w-72 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl p-3 text-left flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
            {list.memberEmails.length} recipient{list.memberEmails.length !== 1 ? "s" : ""}
          </span>
          {list.memberEmails.map((email) => (
            <span key={email} className="text-xs text-slate-700 truncate">
              {email}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export function RecipientBadges({ lists }: { lists: ListInfo[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {lists.map((list) => (
        <RecipientBadge key={list.id} list={list} />
      ))}
    </div>
  );
}
