import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { protectWorkspaceWrites } from '../src/workspace-scope.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}

it('在途编辑属于最初的工作区实例，切回同名工作区后也须重新确认', async () => {
  const app = Fastify();
  let selected = { active: 'docs', generation: 'first' };
  const entered = gate();
  const resume = gate();
  const edits: string[] = [];
  protectWorkspaceWrites(app, () => selected);
  app.addHook('preHandler', async () => { entered.resolve(); await resume.promise; });
  app.post('/api/edit', async () => { edits.push(selected.active); return { saved: true }; });
  const headersFor = () => ({ 'x-concordia-workspace': selected.active, 'x-concordia-generation': selected.generation });
  try {
    const original = headersFor();
    const pending = app.inject({ method: 'POST', url: '/api/edit', headers: original }).then((r) => r.statusCode);
    await entered.promise;
    selected = { active: 'design', generation: 'second' };
    selected = { active: 'docs', generation: 'third' };
    resume.resolve();
    expect(await pending).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/edit' })).statusCode).toBe(409);
    expect(edits).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/edit', headers: headersFor() })).statusCode).toBe(200);
    expect(edits).toEqual(['docs']);
  } finally {
    resume.resolve();
    await app.close();
  }
});
