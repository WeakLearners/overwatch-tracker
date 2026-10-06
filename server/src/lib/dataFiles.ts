// Reference data that the "Check for game updates" button can rewrite lives in
// server/data/*.json, not in code. OW_DATA_DIR lets tests point at a temp copy.
import fs from 'fs';
import path from 'path';

export function dataDir(): string {
  return process.env.OW_DATA_DIR ?? path.resolve(__dirname, '../../data');
}

export function readDataJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')) as T;
}

// One entry per line keeps a git diff of the file readable. Written to a temp
// file and renamed, so a crash never leaves a half-written roster.
export function writeDataJson(name: string, entries: object[] | Record<string, object[]>): void {
  const line = (e: unknown) => '    ' + JSON.stringify(e);
  const text = Array.isArray(entries)
    ? '[\n' + entries.map(e => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n'
    : '{\n' + Object.entries(entries).map(([k, list]) => `  ${JSON.stringify(k)}: [\n${list.map(line).join(',\n')}\n  ]`).join(',\n') + '\n}\n';
  const file = path.join(dataDir(), name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
