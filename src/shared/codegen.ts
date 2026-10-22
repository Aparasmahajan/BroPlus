// Code snippets for a resolved request (Postman's "</>" panel). Pure.
// Input is the request AFTER variable substitution (secrets stay as their
// ${vault:…} reference — the main process never hands expanded secrets out).
import type { HttpRequest } from './http-model';

export const SNIPPET_LANGS = [
  { id: 'curl', label: 'cURL (bash)' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'fetch', label: 'JavaScript (fetch)' },
  { id: 'python', label: 'Python (requests)' },
  { id: 'go', label: 'Go (net/http)' },
  { id: 'httpie', label: 'HTTPie' },
] as const;
export type SnippetLang = (typeof SNIPPET_LANGS)[number]['id'];

function bodyText(r: HttpRequest): string | null {
  if (!r.body) return null;
  if (r.body.text != null) return r.body.text;
  if (r.body.b64 != null) {
    try {
      const bin = atob(r.body.b64);
      return /[\x00-\x08\x0e-\x1f]/.test(bin) ? null : bin;
    } catch {
      return null;
    }
  }
  return null;
}
const isBinary = (r: HttpRequest) => !!r.body && r.body.text == null && bodyText(r) === null;

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // POSIX single quotes
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`; // PowerShell single quotes
const js = (s: string) => JSON.stringify(s);
const py = (s: string) => JSON.stringify(s); // JSON strings are valid Python literals
const goStr = (s: string) => (s.includes('`') ? JSON.stringify(s) : `\`${s}\``);

export function snippet(lang: SnippetLang, r: HttpRequest): string {
  const body = bodyText(r);
  const bin = isBinary(r) ? '\n# (binary body omitted — attach the file yourself)' : '';
  switch (lang) {
    case 'curl': {
      const parts = [`curl --location${r.method === 'GET' ? '' : ` --request ${r.method}`} ${sq(r.url)}`];
      for (const [k, v] of r.headers) parts.push(`--header ${sq(`${k}: ${v}`)}`);
      if (body != null) parts.push(`--data-raw ${sq(body)}`);
      return parts.join(' \\\n  ') + bin;
    }
    case 'powershell': {
      const lines = ['$headers = @{'];
      for (const [k, v] of r.headers) if (k.toLowerCase() !== 'content-type') lines.push(`  ${psq(k)} = ${psq(v)}`);
      lines.push('}');
      const ct = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      let call = `$response = Invoke-WebRequest -Uri ${psq(r.url)} -Method ${r.method} -Headers $headers`;
      if (ct) call += ` -ContentType ${psq(ct)}`;
      if (body != null) {
        lines.push(`$body = @'\n${body}\n'@`);
        call += ' -Body $body';
      }
      lines.push(call, '$response.Content');
      return lines.join('\n') + bin;
    }
    case 'fetch': {
      const opts: string[] = [`  method: ${js(r.method)},`];
      if (r.headers.length) {
        opts.push('  headers: {');
        for (const [k, v] of r.headers) opts.push(`    ${js(k)}: ${js(v)},`);
        opts.push('  },');
      }
      if (body != null) opts.push(`  body: ${js(body)},`);
      return `const response = await fetch(${js(r.url)}, {\n${opts.join('\n')}\n});\nconsole.log(response.status, await response.text());` + bin.replace('#', '//');
    }
    case 'python': {
      const lines = ['import requests', '', `url = ${py(r.url)}`];
      lines.push('headers = {');
      for (const [k, v] of r.headers) lines.push(`    ${py(k)}: ${py(v)},`);
      lines.push('}');
      if (body != null) lines.push(`payload = ${py(body)}`);
      lines.push(
        `response = requests.request(${py(r.method)}, url, headers=headers${body != null ? ', data=payload.encode("utf-8")' : ''})`,
        'print(response.status_code)',
        'print(response.text)',
      );
      return lines.join('\n') + bin;
    }
    case 'go': {
      const lines = [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"io"',
        '\t"net/http"',
        ...(body != null ? ['\t"strings"'] : []),
        ')',
        '',
        'func main() {',
        `\treq, err := http.NewRequest(${js(r.method)}, ${js(r.url)}, ${body != null ? `strings.NewReader(${goStr(body)})` : 'nil'})`,
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
      ];
      for (const [k, v] of r.headers) lines.push(`\treq.Header.Add(${js(k)}, ${js(v)})`);
      lines.push(
        '\tres, err := http.DefaultClient.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer res.Body.Close()',
        '\tdata, _ := io.ReadAll(res.Body)',
        '\tfmt.Println(res.Status)',
        '\tfmt.Println(string(data))',
        '}',
      );
      return lines.join('\n') + bin.replace('#', '//');
    }
    case 'httpie': {
      const parts = [`http --follow ${r.method} ${sq(r.url)}`];
      for (const [k, v] of r.headers) parts.push(sq(`${k}:${v}`));
      const cmd = parts.join(' \\\n  ');
      return (body != null ? `printf '%s' ${sq(body)} | ` : '') + cmd + bin;
    }
  }
}
