import { useRef } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { API_METHODS, NFR_CATEGORIES, STORAGE_KINDS, STORAGE_LABELS, type HldDocument } from '@lld/shared';
import { Button, IconButton, inputClass } from '../components/ui';

type Update = (fn: (d: HldDocument) => HldDocument) => void;
const newId = () => Math.random().toString(36).slice(2, 10);
const area = clsx(inputClass, 'h-auto w-full resize-y py-1.5 leading-[1.45]');
const mono = 'font-mono text-[12.5px]';

function move<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function StageIntro({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 max-w-[78ch] text-[13px] text-muted">{children}</p>
    </div>
  );
}

export function RequirementsStage({ doc, update }: { doc: HldDocument; update: Update }) {
  const refs = useRef(new Map<string, HTMLInputElement>());
  const addFr = (after?: number) => {
    const id = newId();
    update((d) => {
      const list = [...d.functional];
      list.splice(after === undefined ? list.length : after + 1, 0, { id, text: '' });
      return { ...d, functional: list };
    });
    setTimeout(() => refs.current.get(id)?.focus(), 0);
  };
  const addNfr = () => {
    const id = newId();
    update((d) => ({ ...d, nonFunctional: [...d.nonFunctional, { id, category: 'scalability', text: '' }] }));
    setTimeout(() => refs.current.get(id)?.focus(), 0);
  };
  return (
    <div>
      <StageIntro title="Requirements">
        Start by pinning down scope. List what the system must do, then the qualities it must have, with numbers where you can. Press Enter to add the next item.
      </StageIntro>
      <h3 className="mb-1.5 text-[13.5px] font-semibold">Functional requirements</h3>
      <ol className="flex flex-col gap-1.5">
        {doc.functional.map((r, i) => (
          <li key={r.id} className="flex items-center gap-2">
            <span className="tabular w-6 text-right text-[12px] text-faint">{i + 1}.</span>
            <input
              ref={(el) => {
                if (el) refs.current.set(r.id, el);
              }}
              className={clsx(inputClass, 'flex-1')}
              value={r.text}
              placeholder="e.g. Users can post a message to a group"
              aria-label={`Functional requirement ${i + 1}`}
              onChange={(e) => update((d) => ({ ...d, functional: d.functional.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)) }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addFr(i);
                }
              }}
            />
            <IconButton label="Remove requirement" onClick={() => update((d) => ({ ...d, functional: d.functional.filter((x) => x.id !== r.id) }))}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ol>
      <Button className="mt-2" size="sm" icon={<Plus className="size-3.5" />} onClick={() => addFr()}>
        Add functional requirement
      </Button>

      <h3 className="mt-7 mb-1.5 text-[13.5px] font-semibold">Non-functional requirements</h3>
      <ol className="flex flex-col gap-1.5">
        {doc.nonFunctional.map((r, i) => (
          <li key={r.id} className="flex items-center gap-2">
            <span className="tabular w-6 text-right text-[12px] text-faint">{i + 1}.</span>
            <select
              className={clsx(inputClass, 'w-36')}
              aria-label="Category"
              value={r.category}
              onChange={(e) => update((d) => ({ ...d, nonFunctional: d.nonFunctional.map((x) => (x.id === r.id ? { ...x, category: e.target.value as typeof r.category } : x)) }))}
            >
              {NFR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              ref={(el) => {
                if (el) refs.current.set(r.id, el);
              }}
              className={clsx(inputClass, 'flex-1')}
              value={r.text}
              placeholder="e.g. Message delivery p99 under 300 ms"
              aria-label={`Non-functional requirement ${i + 1}`}
              onChange={(e) => update((d) => ({ ...d, nonFunctional: d.nonFunctional.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)) }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addNfr();
                }
              }}
            />
            <IconButton label="Remove requirement" onClick={() => update((d) => ({ ...d, nonFunctional: d.nonFunctional.filter((x) => x.id !== r.id) }))}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ol>
      <Button className="mt-2" size="sm" icon={<Plus className="size-3.5" />} onClick={addNfr}>
        Add non-functional requirement
      </Button>
    </div>
  );
}

export function EstimatesStage({ doc, update }: { doc: HldDocument; update: Update }) {
  return (
    <div>
      <StageIntro title="Back-of-the-envelope estimates">Estimate the numbers that drive your design: traffic, storage, bandwidth, and anything that decides partitioning or caching. Optional, but reviewers notice.</StageIntro>
      <textarea
        className={clsx(area, mono, 'min-h-[420px]')}
        aria-label="Estimates"
        value={doc.estimates}
        onChange={(e) => update((d) => ({ ...d, estimates: e.target.value }))}
        placeholder={`Traffic: 50M DAU × 20 reads/day ≈ 11.5k reads/s (peak ×3 ≈ 35k/s); writes ≈ 1.2k/s\nStorage: 1KB per item × 100M items/day ≈ 100 GB/day ≈ 36 TB/year\nBandwidth: …\nCache: hot 20% of daily reads ≈ …`}
      />
    </div>
  );
}

export function ApiStage({ doc, update }: { doc: HldDocument; update: Update }) {
  const set = (id: string, patch: Partial<HldDocument['apis'][number]>) => update((d) => ({ ...d, apis: d.apis.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  return (
    <div>
      <StageIntro title="API design">One entry per endpoint, RPC or event. Include the key request and response fields, pagination, idempotency keys and error cases where they matter.</StageIntro>
      <div className="flex flex-col gap-3">
        {doc.apis.map((a, i) => (
          <div key={a.id} className="rounded-[6px] border border-line bg-panel p-3">
            <div className="flex items-center gap-2">
              <select className={clsx(inputClass, 'w-24 font-mono')} aria-label="Method" value={a.method} onChange={(e) => set(a.id, { method: e.target.value as typeof a.method })}>
                {API_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input className={clsx(inputClass, 'flex-1', mono)} aria-label="Path or name" placeholder="/v1/messages" value={a.path} onChange={(e) => set(a.id, { path: e.target.value })} />
              <IconButton label="Move up" onClick={() => update((d) => ({ ...d, apis: move(d.apis, i, -1) }))}>
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton label="Move down" onClick={() => update((d) => ({ ...d, apis: move(d.apis, i, 1) }))}>
                <ArrowDown className="size-3.5" />
              </IconButton>
              <IconButton label="Remove endpoint" onClick={() => update((d) => ({ ...d, apis: d.apis.filter((x) => x.id !== a.id) }))}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            <input className={clsx(inputClass, 'mt-2 w-full')} aria-label="Purpose" placeholder="What it does and who calls it" value={a.description} onChange={(e) => set(a.id, { description: e.target.value })} />
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <textarea className={clsx(area, mono, 'min-h-[84px]')} aria-label="Request" placeholder={'Request\n{ "groupId": "…", "text": "…", "idempotencyKey": "…" }'} value={a.request} onChange={(e) => set(a.id, { request: e.target.value })} />
              <textarea className={clsx(area, mono, 'min-h-[84px]')} aria-label="Response" placeholder={'Response\n201 { "messageId": "…", "sentAt": "…" }\n409 duplicate key'} value={a.response} onChange={(e) => set(a.id, { response: e.target.value })} />
            </div>
          </div>
        ))}
      </div>
      <Button
        className="mt-3"
        size="sm"
        icon={<Plus className="size-3.5" />}
        onClick={() => update((d) => ({ ...d, apis: [...d.apis, { id: newId(), method: 'GET', path: '', description: '', request: '', response: '' }] }))}
      >
        Add endpoint
      </Button>
    </div>
  );
}

export function EntitiesStage({ doc, update }: { doc: HldDocument; update: Update }) {
  const set = (id: string, patch: Partial<HldDocument['entities'][number]>) => update((d) => ({ ...d, entities: d.entities.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  return (
    <div>
      <StageIntro title="Entities and data model">Model the core entities, where each lives and how it is accessed. Note keys, indexes and partitioning for the hot paths.</StageIntro>
      <div className="grid gap-3 xl:grid-cols-2">
        {doc.entities.map((en, i) => (
          <div key={en.id} className="rounded-[6px] border border-line bg-panel p-3">
            <div className="flex items-center gap-2">
              <input className={clsx(inputClass, 'flex-1 font-medium')} aria-label="Entity name" placeholder="Message" value={en.name} onChange={(e) => set(en.id, { name: e.target.value })} />
              <select className={clsx(inputClass, 'w-44')} aria-label="Storage" value={en.storage} onChange={(e) => set(en.id, { storage: e.target.value as typeof en.storage })}>
                {STORAGE_KINDS.map((s) => (
                  <option key={s} value={s}>
                    {STORAGE_LABELS[s]}
                  </option>
                ))}
              </select>
              <IconButton label="Move up" onClick={() => update((d) => ({ ...d, entities: move(d.entities, i, -1) }))}>
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton label="Remove entity" onClick={() => update((d) => ({ ...d, entities: d.entities.filter((x) => x.id !== en.id) }))}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            <textarea
              className={clsx(area, mono, 'mt-2 min-h-[110px]')}
              aria-label="Fields"
              placeholder={'message_id: uuid (PK)\ngroup_id: uuid (partition key)\nsender_id: uuid\nbody: text\ncreated_at: timestamp (sort key)'}
              value={en.fields}
              onChange={(e) => set(en.id, { fields: e.target.value })}
            />
            <input className={clsx(inputClass, 'mt-2 w-full')} aria-label="Notes" placeholder="Indexes, retention, access pattern…" value={en.notes} onChange={(e) => set(en.id, { notes: e.target.value })} />
          </div>
        ))}
      </div>
      <Button
        className="mt-3"
        size="sm"
        icon={<Plus className="size-3.5" />}
        onClick={() => update((d) => ({ ...d, entities: [...d.entities, { id: newId(), name: '', storage: 'sql', fields: '', notes: '' }] }))}
      >
        Add entity
      </Button>
    </div>
  );
}

export function NotesStage({ doc, update }: { doc: HldDocument; update: Update }) {
  return (
    <div>
      <StageIntro title="Deep dives and trade-offs">Explain the hard parts: how the design meets the non-functional requirements, what you would do at 10× scale, failure handling, and the alternatives you rejected and why.</StageIntro>
      <textarea
        className={clsx(area, 'min-h-[460px]')}
        aria-label="Deep dives and trade-offs"
        value={doc.notes}
        onChange={(e) => update((d) => ({ ...d, notes: e.target.value }))}
        placeholder={'## Write path\n…\n\n## Read path and caching\n…\n\n## Scaling and partitioning\n…\n\n## Failure handling\n…\n\n## Trade-offs\n- Chose X over Y because …'}
      />
    </div>
  );
}
