import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ThinkroidMemory } from '../src/api.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Summaries table (P7-B1, DL-48)', () => {
  let memory;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-'));
    const dbPath = path.join(tmpDir, 'memory.db');
    memory = new ThinkroidMemory(dbPath, 'test-agent');
    memory.open();
  });

  afterEach(() => {
    memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeSummary creates a summary entry', () => {
    const l2 = memory.viewForCerebellumL2();
    const { id } = l2.writeSummary({
      level: 'daily',
      periodStart: 1000,
      periodEnd: 2000,
      content: 'Today was productive.',
      sourceIds: [1, 2],
    });
    expect(id).toBeGreaterThan(0);
  });

  it('findSummaries returns summaries within period range', () => {
    const l2 = memory.viewForCerebellumL2();
    l2.writeSummary({ level: 'daily', periodStart: 1000, periodEnd: 2000, content: 'Day 1' });
    l2.writeSummary({ level: 'daily', periodStart: 2000, periodEnd: 3000, content: 'Day 2' });
    l2.writeSummary({ level: 'daily', periodStart: 5000, periodEnd: 6000, content: 'Day 3 (outside)' });

    const results = l2.findSummaries({ level: 'daily', periodStart: 1000, periodEnd: 3000 });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('Day 1');
    expect(results[1].content).toBe('Day 2');
  });

  it('findSummaries filters by level', () => {
    const l2 = memory.viewForCerebellumL2();
    l2.writeSummary({ level: 'daily', periodStart: 1000, periodEnd: 2000, content: 'Daily' });
    l2.writeSummary({ level: 'weekly', periodStart: 1000, periodEnd: 2000, content: 'Weekly' });

    const dailies = l2.findSummaries({ level: 'daily', periodStart: 0, periodEnd: 9999 });
    expect(dailies).toHaveLength(1);
    expect(dailies[0].content).toBe('Daily');
  });

  it('latestSummary returns most recent by level', () => {
    const l2 = memory.viewForCerebellumL2();
    l2.writeSummary({ level: 'daily', periodStart: 1000, periodEnd: 2000, content: 'Older' });
    l2.writeSummary({ level: 'daily', periodStart: 3000, periodEnd: 4000, content: 'Newer' });

    const latest = l2.latestSummary({ level: 'daily' });
    expect(latest.content).toBe('Newer');
    expect(latest.period_end).toBe(4000);
  });

  it('latestSummary returns null when no summaries exist', () => {
    const l2 = memory.viewForCerebellumL2();
    expect(l2.latestSummary({ level: 'daily' })).toBeNull();
  });

  it('source_ids JSON round-trip', () => {
    const l2 = memory.viewForCerebellumL2();
    l2.writeSummary({ level: 'daily', periodStart: 1000, periodEnd: 2000, content: 'Test', sourceIds: [10, 20, 30] });
    const latest = l2.latestSummary({ level: 'daily' });
    expect(latest.source_ids).toEqual([10, 20, 30]);
  });

  it('schema migration v2→v3 creates summaries table', () => {
    // The table already exists because open() ran the migration
    const l2 = memory.viewForCerebellumL2();
    // Just verify we can write and read
    l2.writeSummary({ level: 'weekly', periodStart: 0, periodEnd: 1000, content: 'Week 1' });
    const results = l2.findSummaries({ level: 'weekly', periodStart: 0, periodEnd: 9999 });
    expect(results).toHaveLength(1);
  });

  it('default sourceIds is empty array', () => {
    const l2 = memory.viewForCerebellumL2();
    l2.writeSummary({ level: 'daily', periodStart: 0, periodEnd: 1000, content: 'No sources' });
    const latest = l2.latestSummary({ level: 'daily' });
    expect(latest.source_ids).toEqual([]);
  });
});
