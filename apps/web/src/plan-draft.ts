import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from './api.ts';

type Saved = { text: string; revision: number };
type Status = 'loading' | 'saved' | 'saving' | 'error';
type View = { text: string; status: Status; error: string };
/** Serialize autosaves across navigation in this tab. The server revision fences other tabs. */
class PlanDraft {
  view: View = { text: '', status: 'loading', error: '' };
  private listeners = new Set<() => void>();
  private revision: number | undefined;
  private savedText = '';
  private busy = false;
  private edits = 0;
  constructor(readonly workspace?: string) {
    if (!workspace) this.view.status = 'saved';
  }
  snapshot = () => this.view;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private get path() {
    return 'plan-draft/' + encodeURIComponent(this.workspace!);
  }
  async restore(force = false) {
    if (!this.workspace || this.busy || (!force && this.view.status === 'error')) return;
    this.busy = true;
    const edits = this.edits;
    let saved = false;
    try {
      this.update({ status: 'loading', error: '' });
      const row = await api<Saved>(this.path);
      this.revision = row.revision;
      this.savedText = row.text;
      saved = true;
      if (this.edits === edits) this.update({ text: row.text, status: 'saved' });
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
    if (saved && this.edits !== edits) await this.flush();
  }
  edit = (text: string) => {
    this.edits++;
    this.update({ text, status: this.workspace ? 'saving' : 'saved', error: '' });
    void this.flush();
  };
  private fail(error: unknown) {
    this.update({ status: 'error', error: error instanceof Error ? error.message : '草稿尚未保存。' });
  }
  async flush() {
    if (!this.workspace || this.busy) return;
    if (this.revision === undefined) {
      this.fail(new Error('尚未读取服务端草稿，当前文字仍保留在本页。'));
      return;
    }
    this.busy = true;
    try {
      while (this.savedText !== this.view.text) {
        const text = this.view.text;
        const result: { revision: number } = await api<{ revision: number }>(this.path, 'PUT', {
          text,
          revision: this.revision,
        });
        this.revision = result.revision;
        this.savedText = text;
      }
      this.update({ status: 'saved', error: '' });
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
  }
}
const sessions = new Map<string, PlanDraft>();
export function usePlanDraft(workspace?: string) {
  const state = useMemo(() => {
    if (!workspace) return new PlanDraft();
    const prior = sessions.get(workspace);
    if (prior) return prior;
    const next = new PlanDraft(workspace);
    sessions.set(workspace, next);
    return next;
  }, [workspace]);
  const view = useSyncExternalStore(state.subscribe, state.snapshot);
  useEffect(() => {
    void state.restore();
  }, [state]);
  useEffect(() => {
    if (!workspace || (view.status !== 'saving' && view.status !== 'error')) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [workspace, view.status]);
  return { view, edit: state.edit, restore: () => state.restore(true), retry: () => state.flush() };
}
