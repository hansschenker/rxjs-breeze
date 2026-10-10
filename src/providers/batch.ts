/**
 * OData `$batch` payloads, built and parsed as pure functions: the
 * multipart/mixed format of OData 4.0 and the JSON format of OData 4.01.
 */

export interface BatchReq {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON-serializable body, if any. */
  readonly body?: unknown;
  /** Content-IDs this request refers to with `$n`. */
  readonly dependsOn?: readonly string[];
}

export interface BatchRes {
  readonly id?: string;
  readonly status: number;
  readonly statusText: string;
  /** Raw body text; empty for 204. */
  readonly body: string;
}

export interface Payload {
  readonly contentType: string;
  readonly body: string;
}

const CRLF = '\r\n';
const token = (): string => Math.random().toString(36).slice(2, 10);

/** One batch holding one changeset with every request, so the server applies all or nothing. */
export const buildMultipart = (reqs: readonly BatchReq[]): Payload => {
  const batch = `batch_${token()}`;
  const set = `changeset_${token()}`;
  const parts = reqs.map((r) =>
    [
      `--${set}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      `Content-ID: ${r.id}`,
      '',
      `${r.method} ${r.url} HTTP/1.1`,
      ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`),
      '',
      r.body === undefined ? '' : JSON.stringify(r.body),
    ].join(CRLF),
  );
  const body = [
    `--${batch}`,
    `Content-Type: multipart/mixed; boundary=${set}`,
    '',
    ...parts,
    `--${set}--`,
    `--${batch}--`,
    '',
  ].join(CRLF);
  return { contentType: `multipart/mixed; boundary=${batch}`, body };
};

const boundaryOf = (contentType: string): string | undefined =>
  /boundary="?([^";\s]+)"?/i.exec(contentType)?.[1];

const headersOf = (block: string): { readonly headers: Record<string, string>; readonly rest: string } => {
  const m = /\r?\n\r?\n/.exec(block);
  const head = m ? block.slice(0, m.index) : block;
  const rest = m ? block.slice(m.index + m[0].length) : '';
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, rest };
};

const partsOf = (text: string, boundary: string): string[] =>
  text
    .split(`--${boundary}`)
    .slice(1)
    .filter((p) => !p.startsWith('--'))
    .map((p) => p.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));

const parseHttp = (block: string, id?: string): BatchRes => {
  const nl = block.search(/\r?\n/);
  const statusLine = nl < 0 ? block : block.slice(0, nl);
  const m = /^HTTP\/\d(?:\.\d)? (\d{3})\s*(.*)$/.exec(statusLine);
  const { headers, rest } = headersOf(nl < 0 ? '' : block.slice(nl).replace(/^\r?\n/, ''));
  return {
    id: id ?? headers['content-id'],
    status: m ? Number(m[1]) : 0,
    statusText: m?.[2] ?? '',
    body: rest,
  };
};

/** Flatten a multipart response, changesets included, into one response per request. */
export const parseMultipart = (text: string, contentType: string): BatchRes[] => {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error('rxjs-breeze: $batch response is not multipart/mixed');
  return partsOf(text, boundary).flatMap((part) => {
    const { headers, rest } = headersOf(part);
    const ct = headers['content-type'] ?? '';
    if (ct.startsWith('multipart/mixed')) return parseMultipart(rest, ct);
    if (ct.startsWith('application/http')) return [parseHttp(rest, headers['content-id'])];
    return [];
  });
};

/** OData 4.01 JSON batch: every request in one atomicity group. */
export const buildJson = (reqs: readonly BatchReq[], group = 'g1'): Payload => ({
  contentType: 'application/json',
  body: JSON.stringify({
    requests: reqs.map((r) => ({
      id: r.id,
      method: r.method,
      url: r.url,
      headers: r.headers,
      ...(r.body === undefined ? {} : { body: r.body }),
      atomicityGroup: group,
      ...(r.dependsOn && r.dependsOn.length > 0 ? { dependsOn: r.dependsOn } : {}),
    })),
  }),
});

export const parseJson = (text: string): BatchRes[] => {
  const raw = JSON.parse(text) as { responses?: { id?: string; status?: number; body?: unknown }[] };
  return (raw.responses ?? []).map((r) => ({
    id: r.id,
    status: r.status ?? 0,
    statusText: '',
    body: r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
  }));
};
