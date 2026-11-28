import { isEndpointPath } from '@concordia/protocol/connections';
import type { ProviderConfig, Protocol } from './model-types.ts';

const nativePaths = { 'chat-completions': 'chat/completions', responses: 'responses', anthropic: 'messages' };

/** One URL resolver for the human-facing review and the actual outbound request. */
export function modelEndpoint(config: Pick<ProviderConfig, 'protocol' | 'model' | 'baseUrl' | 'endpoint' | 'stream'>, stream = config.stream ?? true): URL {
  const root = new URL(config.baseUrl);
  if (root.username || root.password || root.hash || root.search ||
      !(root.protocol === 'https:' || (root.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname))))
    throw new Error('invalid base url');
  const protocol: Protocol = config.protocol;
  const native = protocol === 'gemini'
    ? 'models/' + encodeURIComponent(config.model.replace(/^models\//, '')) + ':' + (stream ? 'streamGenerateContent' : 'generateContent')
    : nativePaths[protocol];
  const path = config.endpoint ?? native;
  if (typeof path !== 'string' || !isEndpointPath(path)) throw new Error('invalid endpoint');
  root.pathname = root.pathname.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
  if (protocol === 'gemini' && stream) root.searchParams.set('alt', 'sse');
  return root;
}
