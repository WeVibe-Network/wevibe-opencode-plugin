import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error tsx test runner resolves .ts extension imports.
import { buildRecallHarvest, classifyIntent } from './recall-harvest.ts';

test('classifyIntent returns debug for error-style prompt', () => {
  assert.equal(classifyIntent('Fix crash in websocket handler', {}), 'debug');
});

test('classifyIntent returns debug when build is failing', () => {
  assert.equal(classifyIntent('implement login flow', { buildFailing: true }), 'debug');
});

test('classifyIntent returns test for test-centric prompt', () => {
  assert.equal(classifyIntent('add a test for X', {}), 'test');
});

test('classifyIntent returns refactor for refactor-centric prompt', () => {
  assert.equal(classifyIntent('refactor the parser', {}), 'refactor');
});

test('classifyIntent returns explain for explanation prompt', () => {
  assert.equal(classifyIntent('explain how recall works', {}), 'explain');
});

test('classifyIntent returns implement by default', () => {
  assert.equal(classifyIntent('implement the login page', {}), 'implement');
});

test('buildRecallHarvest maps representative live signals into populated fields', () => {
  const result = buildRecallHarvest({
    prompt: 'Fix the redis ECONNREFUSED on reconnect',
    language: 'TypeScript',
    deps: ['ioredis', 'vitest'],
    frameworks: ['vitest'],
    stack: ['Node.js', 'TypeScript'],
    projectName: 'wevibe-mcp',
    directory: 'wevibe-mcp',
    errorStrings: ['ECONNREFUSED 127.0.0.1:6379'],
    editedFiles: ['src/cache.ts'],
    buildFailing: false,
    testFailing: true,
  });

  assert.equal(result.intent, 'debug');
  assert.ok(result.task?.toLowerCase().includes('redis'));
  assert.equal(result.language, 'TypeScript');
  assert.ok(result.stack?.includes('Node.js'));
  assert.ok(result.deps?.includes('ioredis'));
  assert.ok(result.errorStrings?.includes('ECONNREFUSED 127.0.0.1:6379'));
  assert.ok(result.files?.includes('src/cache.ts'));
  assert.equal(result.buildFailing, false);
  assert.equal(result.testFailing, true);
});

test('buildRecallHarvest omits empty optional arrays and strings', () => {
  const result = buildRecallHarvest({
    prompt: '',
    deps: [],
    frameworks: [],
    stack: [],
    errorStrings: [],
    editedFiles: [],
  });

  assert.equal(result.intent, 'implement');
  assert.ok(!('stack' in result));
  assert.ok(!('deps' in result));
  assert.ok(!('files' in result));
  assert.ok(!('errorStrings' in result));
  assert.ok(!('buildFailing' in result));
  assert.ok(!('testFailing' in result));
});
