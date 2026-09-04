import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PARSED_DIR } from '../server/config.js';
import { readBlocks, readParsedText } from '../server/store.js';
import { createRun, saveResult, activateVersion, listVersions, snapshotLegacy, jsonWrite } from '../server/parser/versions.js';

test('versions preserve legacy bytes, isolate candidates, reject invalid content, and restore exactly', () => {
  const root = fs.mkdtempSync(path.join(PARSED_DIR, 'qa_parser_'));
  const id = path.basename(root);
  try {
    const old = [{ type: 'para', md: 'original cached text', page: 1 }];
    jsonWrite(path.join(root, 'blocks.json'), old);
    fs.writeFileSync(path.join(root, 'full.md'), 'original cached text');
    snapshotLegacy(id);
    const legacy = listVersions(id).active;
    const frozen = fs.readFileSync(path.join(root, 'blocks.json'), 'utf8');
    const doc = (text, errors = []) => ({ v: 4, meta: { engine: 'hybrid' }, blocks: [{ type: 'para', md: text, page: 1 }], quality: { errors, warnings: [] } });
    const next = createRun(id, 'hybrid');
    saveResult(next, doc('new text'));
    assert.equal(readBlocks(id)[0].md, 'original cached text');
    activateVersion(id, next.id);
    assert.equal(readBlocks(id).blocks[0].md, 'new text');
    const versionBytes = fs.readFileSync(path.join(next.dir, 'blocks.json'), 'utf8');
    const before = fs.statSync(path.join(next.dir, 'blocks.json')).mtimeMs;
    readBlocks(id); readParsedText(id); listVersions(id);
    assert.equal(fs.statSync(path.join(next.dir, 'blocks.json')).mtimeMs, before);
    activateVersion(id, legacy);
    assert.equal(readBlocks(id)[0].md, 'original cached text');
    activateVersion(id, next.id);
    assert.equal(fs.readFileSync(path.join(next.dir, 'blocks.json'), 'utf8'), versionBytes);
    const failed = createRun(id, 'hybrid');
    saveResult(failed, doc('bad', [{ code: 'missing-page' }]));
    assert.throws(() => activateVersion(id, failed.id), /校验/);
    assert.equal(listVersions(id).active, next.id);
    const corrupt = createRun(id, 'hybrid');
    saveResult(corrupt, doc('intact'));
    fs.writeFileSync(path.join(corrupt.dir, 'full.md'), 'corrupted');
    assert.throws(() => activateVersion(id, corrupt.id), /校验/);
    assert.equal(listVersions(id).active, next.id);
    assert.equal(fs.readFileSync(path.join(root, 'blocks.json'), 'utf8'), frozen);
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(PARSED_DIR));
    assert.ok(path.basename(resolved).startsWith('qa_parser_'));
    fs.rmSync(resolved, { recursive: true });
  }
});
