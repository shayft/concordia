import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

interface EventRecord {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}
interface Page {
  events: EventRecord[];
  hasMore: boolean;
}
const limit = 100;
export function useHistoryFeed(events: number) {
  const [data, setData] = useState<EventRecord[]>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [historic, setHistoric] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const state = useRef<{ page?: Page; historic: boolean }>({ historic: false });
  const seq = useRef(0);
  const load = useCallback(async (mode: 'latest' | 'older' | 'increment') => {
    const previous = state.current;
    if (mode === 'increment' && previous.historic) return;
    const cursor =
      mode === 'older'
        ? previous.page?.events[0]?.seq
        : mode === 'increment'
          ? previous.page?.events.at(-1)?.seq
          : undefined;
    const param = mode === 'older' ? 'before' : 'after';
    const request = ++seq.current;
    if (mode === 'older') state.current = { ...previous, historic: true };
    setLoading(true);
    try {
      let page = await api<Page>(
        'history/page?limit=' + limit + (cursor !== undefined ? '&' + param + '=' + cursor : ''),
      );
      if (request !== seq.current) return;
      if (mode === 'increment' && cursor !== undefined) {
        if (page.hasMore) {
          page = await api<Page>('history/page?limit=' + limit);
          if (request !== seq.current) return;
        } else {
          const merged = [...previous.page!.events, ...page.events];
          page = { events: merged.slice(-limit), hasMore: previous.page!.hasMore || merged.length > limit };
        }
      }
      const historic = mode === 'older';
      state.current = { page, historic };
      setHistoric(historic);
      setHasOlder(page.hasMore);
      setData(page.events);
      setError('');
    } catch (err) {
      if (request === seq.current) {
        state.current = previous;
        setError(err instanceof Error ? err.message : '读取历史失败。');
      }
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load('latest');
    return () => {
      seq.current++;
    };
  }, [load]);
  useEffect(() => {
    if (events) void load('increment');
  }, [events, load]);
  return { data, error, loading, historic, hasOlder, load };
}
