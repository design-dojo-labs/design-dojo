import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FilePlus2, FolderPlus, Lock, Pencil, Trash2, FileCode2, FileText, Folder, Download, Upload } from 'lucide-react';
import type { ExcludedEntry, TreeEntry } from '@lld/shared';
import { errorMessage, get, post } from '../lib/api';
import { IconButton, useConfirm, usePrompt, useToast } from '../components/ui';
import { useFilesVersion, useWorkspace } from './context';

interface Node {
  name: string;
  path: string;
  type: 'file' | 'dir';
  locked: boolean;
  children: Node[];
}

function buildTree(entries: TreeEntry[]): Node[] {
  const root: Node = { name: '', path: '', type: 'dir', locked: false, children: [] };
  const dirs = new Map<string, Node>([['', root]]);
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const parentPath = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    const parent = dirs.get(parentPath) ?? root;
    const node: Node = { name: e.path.split('/').pop()!, path: e.path, type: e.type, locked: e.locked, children: [] };
    parent.children.push(node);
    if (e.type === 'dir') dirs.set(e.path, node);
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export const treeKey = (sid: string) => ['tree', sid] as const;

export function useTree(sessionId: string) {
  return useQuery({
    queryKey: treeKey(sessionId),
    queryFn: () => get<{ entries: TreeEntry[]; skipped: ExcludedEntry[] }>(`/api/sessions/${sessionId}/tree`),
    refetchInterval: 4000, // detects edits made in another editor; paused while the tab is hidden
  });
}

function javaStub(path: string): string {
  const m = path.match(/^src\/(main|test)\/java\/(.+)\/([A-Za-z_$][\w$]*)\.java$/);
  const top = path.match(/^src\/(main|test)\/java\/([A-Za-z_$][\w$]*)\.java$/);
  if (!m && !top) return '';
  const pkg = m ? m[2].replace(/\//g, '.') : null;
  const cls = m ? m[3] : top![2];
  return `${pkg ? `package ${pkg};\n\n` : ''}public class ${cls} {\n}\n`;
}

export function FileTree() {
  const ws = useWorkspace();
  const { session, files } = ws;
  useFilesVersion(files);
  const qc = useQueryClient();
  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const tree = useTree(session.id);
  const storeKey = `lld.tree.${session.id}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storeKey);
      if (saved) return new Set(JSON.parse(saved));
    } catch {
      /* ignore */
    }
    const pkg = session.packageName.replace(/\./g, '/');
    const open = new Set<string>(['src', 'src/main', 'src/main/java', 'src/test', 'src/test/java']);
    let acc = '';
    for (const seg of pkg.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      open.add(`src/main/java/${acc}`);
      open.add(`src/test/java/${acc}`);
    }
    return open;
  });
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify([...expanded]));
    } catch {
      /* ignore */
    }
  }, [expanded, storeKey]);

  const nodes = useMemo(() => buildTree(tree.data?.entries ?? []), [tree.data]);
  const visible = useMemo(() => {
    const out: { node: Node; depth: number }[] = [];
    const walk = (list: Node[], depth: number) => {
      for (const n of list) {
        out.push({ node: n, depth });
        if (n.type === 'dir' && expanded.has(n.path)) walk(n.children, depth + 1);
      }
    };
    walk(nodes, 0);
    return out;
  }, [nodes, expanded]);

  const refresh = () => qc.invalidateQueries({ queryKey: treeKey(session.id) });
  const toggle = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const baseDir = () => {
    if (!selected) return `src/main/java/${session.packageName.replace(/\./g, '/')}/`;
    const e = tree.data?.entries.find((x) => x.path === selected);
    if (e?.type === 'dir') return `${selected}/`;
    return selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/') + 1) : '';
  };

  const fsOp = async (body: Record<string, unknown>) => {
    try {
      await post(`/api/sessions/${session.id}/fs`, body);
      await refresh();
      return true;
    } catch (e) {
      toast('err', errorMessage(e));
      return false;
    }
  };

  const newFile = async () => {
    const path = await prompt({
      title: 'New file',
      label: 'Path in the project',
      initial: baseDir(),
      confirmLabel: 'Create file',
      hint: 'Folders are created as needed. A .java file under src/main/java or src/test/java gets a package declaration and class stub.',
    });
    if (!path) return;
    if (await fsOp({ op: 'create', path, content: javaStub(path) })) {
      setExpanded((s) => {
        const n = new Set(s);
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join('/'));
        return n;
      });
      setSelected(path);
      await ws.openFile(path).catch((e) => toast('err', errorMessage(e)));
    }
  };

  const newFolder = async () => {
    const path = await prompt({ title: 'New folder', label: 'Folder path', initial: baseDir(), confirmLabel: 'Create folder' });
    if (path && (await fsOp({ op: 'mkdir', path: path.replace(/\/+$/, '') }))) setExpanded((s) => new Set(s).add(path.replace(/\/+$/, '')));
  };

  const rename = async (path: string) => {
    const to = await prompt({ title: 'Rename or move', label: 'New path', initial: path, confirmLabel: 'Rename', hint: 'Change folders in the path to move it. Package declarations are not updated automatically.' });
    if (!to || to === path) return;
    const open = files.under(path);
    const unsaved = await files.flushAll();
    if (unsaved.some((u) => u === path || u.startsWith(path + '/'))) {
      toast('err', 'Resolve the unsaved or conflicting changes in this item before renaming it.');
      return;
    }
    if (await fsOp({ op: 'rename', path, newPath: to })) {
      open.forEach((b) => files.close(b.path));
      ws.renameTabs(path, to);
      setSelected(to);
    }
  };

  const remove = async (path: string, type: 'file' | 'dir') => {
    const ok = await confirm({
      title: `Delete ${type === 'dir' ? 'folder' : 'file'}?`,
      body: (
        <>
          <code className="font-mono text-ink">{path}</code> will be moved to the trash folder in the studio data directory, so you can still recover it from disk.
        </>
      ),
      confirmLabel: 'Move to trash',
      danger: true,
    });
    if (!ok) return;
    for (const b of files.under(path)) files.close(b.path);
    if (await fsOp({ op: 'delete', path })) {
      ws.closeUnder(path);
      setSelected(null);
    }
  };

  const importZip = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      const res = await post<{ imported: string[]; replaced: string[]; skipped: { path: string; reason: string }[] }>(`/api/sessions/${session.id}/import`, { zipBase64: btoa(bin) });
      await refresh();
      for (const p of res.replaced) if (files.get(p)) await files.loadFromDisk(p);
      toast(
        res.skipped.length ? 'info' : 'ok',
        `Imported ${res.imported.length} file(s)${res.replaced.length ? `, ${res.replaced.length} replaced (old versions in trash)` : ''}${res.skipped.length ? `. Skipped ${res.skipped.length}: ${res.skipped.slice(0, 4).map((s) => `${s.path} (${s.reason})`).join(', ')}` : ''}.`,
      );
    } catch (e) {
      toast('err', errorMessage(e));
    }
  };

  const onKey = (e: React.KeyboardEvent, idx: number) => {
    const item = visible[idx];
    if (!item) return;
    const focusAt = (i: number) => {
      const el = listRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[i];
      el?.focus();
      setSelected(visible[i]?.node.path ?? null);
    };
    if (e.key === 'ArrowDown') (e.preventDefault(), focusAt(Math.min(idx + 1, visible.length - 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), focusAt(Math.max(idx - 1, 0)));
    else if (e.key === 'ArrowRight' && item.node.type === 'dir') {
      e.preventDefault();
      if (!expanded.has(item.node.path)) toggle(item.node.path);
      else focusAt(idx + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (item.node.type === 'dir' && expanded.has(item.node.path)) toggle(item.node.path);
      else {
        const parent = item.node.path.slice(0, item.node.path.lastIndexOf('/'));
        const pi = visible.findIndex((v) => v.node.path === parent);
        if (pi >= 0) focusAt(pi);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (item.node.type === 'dir') toggle(item.node.path);
      else void ws.openFile(item.node.path).catch((err) => toast('err', errorMessage(err)));
    } else if (e.key === 'F2' && !item.node.locked) (e.preventDefault(), void rename(item.node.path));
    else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && !item.node.locked) (e.preventDefault(), void remove(item.node.path, item.node.type));
  };

  const activePath = ws.activeTabId?.startsWith('ws:') ? ws.activeTabId.slice(3) : null;
  const selectedNode = visible.find((v) => v.node.path === selected)?.node;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-2">
        <span className="mr-auto text-[12.5px] font-medium">Files</span>
        <IconButton label="New file" onClick={newFile}>
          <FilePlus2 className="size-4" />
        </IconButton>
        <IconButton label="New folder" onClick={newFolder}>
          <FolderPlus className="size-4" />
        </IconButton>
        <IconButton label="Rename or move selected" disabled={!selectedNode || selectedNode.locked} onClick={() => selectedNode && rename(selectedNode.path)}>
          <Pencil className="size-3.5" />
        </IconButton>
        <IconButton label="Delete selected" disabled={!selectedNode || selectedNode.locked} onClick={() => selectedNode && remove(selectedNode.path, selectedNode.type)}>
          <Trash2 className="size-3.5" />
        </IconButton>
        <IconButton label="Import ZIP into workspace" onClick={() => fileInput.current?.click()}>
          <Upload className="size-3.5" />
        </IconButton>
        <a href={`/api/sessions/${session.id}/export.zip`} download aria-label="Export workspace as ZIP" title="Export workspace as ZIP" className="inline-flex size-7 items-center justify-center rounded-[4px] text-muted hover:bg-sunken hover:text-ink">
          <Download className="size-3.5" />
        </a>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importZip(f);
          }}
        />
      </div>
      <ul ref={listRef} role="tree" aria-label="Project files" className="min-h-0 flex-1 overflow-auto py-1 text-[13px]">
        {visible.map(({ node, depth }, i) => {
          const b = node.type === 'file' ? files.get(node.path) : undefined;
          const dirty = b && b.state !== 'saved';
          return (
            <li
              key={node.path}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={node.type === 'dir' ? expanded.has(node.path) : undefined}
              aria-selected={selected === node.path}
              tabIndex={selected === node.path || (!selected && i === 0) ? 0 : -1}
              onKeyDown={(e) => onKey(e, i)}
              onClick={() => {
                setSelected(node.path);
                if (node.type === 'dir') toggle(node.path);
                else void ws.openFile(node.path).catch((err) => toast('err', errorMessage(err)));
              }}
              onDoubleClick={() => node.type === 'file' && !node.locked && rename(node.path)}
              className={clsx(
                'flex cursor-pointer items-center gap-1 py-[3px] pr-2 select-none',
                selected === node.path ? 'bg-select' : 'hover:bg-sunken',
                activePath === node.path && 'font-medium text-ink',
                node.locked && 'text-faint',
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={node.locked ? `${node.path} (managed by the studio, read-only)` : node.path}
            >
              {node.type === 'dir' ? (
                expanded.has(node.path) ? (
                  <ChevronDown className="size-3.5 shrink-0 text-faint" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-faint" />
                )
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {node.type === 'dir' ? (
                <Folder className="size-3.5 shrink-0 text-faint" />
              ) : node.name.endsWith('.java') ? (
                <FileCode2 className="size-3.5 shrink-0 text-accent" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-faint" />
              )}
              <span className="truncate">{node.name}</span>
              {node.locked && <Lock className="ml-1 size-3 shrink-0 text-faint" aria-label="read-only" />}
              {dirty && <span className={clsx('ml-auto size-1.5 shrink-0 rounded-full', b?.state === 'conflict' || b?.state === 'error' ? 'bg-err' : 'bg-accent')} aria-label="unsaved changes" />}
            </li>
          );
        })}
      </ul>
      {!!tree.data?.skipped.length && (
        <div className="border-t border-line px-2 py-1.5 text-[11.5px] text-faint">
          Hidden: {tree.data.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}
        </div>
      )}
      {tree.error && <div className="border-t border-line px-2 py-1 text-[12px] text-err">{errorMessage(tree.error)}</div>}
    </div>
  );
}
