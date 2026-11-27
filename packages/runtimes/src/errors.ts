// Only fixed diagnostic messages from Concordia may reach the command line.
export class CliDiagnosticError extends Error {}

const nativeErrorPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:\b401\b|unauthori[sz]ed|not (?:logged|signed) in|invalid[_ -](?:api[_ -]key|token)|authentication (?:failed|required)|token[_ -]expired)/i, '认证失败'],
  [/(?:\b429\b|rate[_ -]limit|quota|insufficient[_ -](?:credits|balance)|usage limit)/i, '限流或额度不足'],
  [/(?:\b403\b|forbidden)/i, '服务拒绝访问'],
  [/(?:model[_ -](?:not[_ -]found|unavailable)|unsupported (?:model|feature)|model.{0,70}(?:does not exist|not supported|not available)|unknown feature)/i, '模型或功能不受支持'],
  [/(?:unexpected argument|invalid (?:value|argument)|unrecognized (?:option|argument|subcommand)|unknown (?:option|argument|flag)|requires? a value|missing required argument)/i, '启动参数不兼容'],
  [/(?:dns|name (?:resolution|lookup)|getaddrinfo|enotfound|econn(?:refused|reset)|failed to resolve|network (?:is unreachable|error)|error sending request|connection (?:refused|reset|timed out)|proxy (?:error|connect)|failed to connect|tls handshake)/i, '网络、代理或 DNS 异常'],
  [/(?:sandbox.{0,80}(?:denied|fail|cannot|unavailable)|(?:denied|failed).{0,80}sandbox|read-only file system|operation not permitted|permission denied|access is denied|\beacces\b|\beperm\b)/i, '本机沙箱或权限限制'],
  [/(?:\b50[0234]\b|internal server error|service unavailable)/i, '上游服务异常'],
];

// Classify in memory. The serialization path accepts only the constant labels
// above. A nonfatal Codex PATH-alias warning can precede unrelated errors.
export function nativeErrorCategory(message: string) {
  const evidence = message.split('\n').filter(line =>
    !/^warning:\s*proceeding, even though we could not create PATH aliases:/i.test(line.trim())).join('\n');
  return nativeErrorPatterns.find(([pattern]) => pattern.test(evidence))?.[1] ?? '原因未知';
}
