import { randomUUID } from 'node:crypto';

export class TokenUsageStore {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    if (!db) throw new Error('TokenUsageStore requires an opened Database handle');
    this._db = db;
  }

  /**
   * Record one daemon-owned token usage event. Duplicate IDs are ignored
   * so Space can replay notifications without double-counting durable totals.
   *
   * @param {object} event
   * @returns {boolean} true when a row was inserted
   */
  record(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('TokenUsageStore.record: event must be an object');
    }
    if (typeof event.agentId !== 'string' || event.agentId.length === 0) {
      throw new Error('TokenUsageStore.record: event.agentId must be a non-empty string');
    }

    const usage = event.usage && typeof event.usage === 'object' ? event.usage : event;
    const id = typeof event.id === 'string' && event.id.length > 0
      ? event.id
      : (typeof usage.id === 'string' && usage.id.length > 0 ? usage.id : randomUUID());
    const promptTokens = tokenInt(usage.prompt_tokens ?? usage.input_tokens);
    const completionTokens = tokenInt(usage.completion_tokens ?? usage.output_tokens);
    const totalTokens = tokenInt(usage.total_tokens ?? (promptTokens + completionTokens));
    const cacheCreationTokens = tokenInt(usage.cache_creation_input_tokens);
    const cacheReadTokens = tokenInt(usage.cache_read_input_tokens);
    const createdAt = Number.isFinite(event.createdAt)
      ? event.createdAt
      : (Number.isFinite(usage.createdAt) ? usage.createdAt : Date.now());

    const info = this._db.prepare(`
      INSERT OR IGNORE INTO token_usage (
        id, agent_id, task_id, prompt_tokens, completion_tokens, total_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        model, provider_id, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.agentId,
      event.taskId ?? usage.taskId ?? null,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheCreationTokens,
      cacheReadTokens,
      event.model ?? usage.model ?? null,
      event.providerId ?? usage.providerId ?? null,
      event.source ?? usage.source ?? 'brain.chat',
      createdAt,
    );
    return info.changes > 0;
  }

  totals() {
    const row = this._db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens
      FROM token_usage
    `).get();
    return {
      count: row.count,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      total_tokens: row.total_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens,
    };
  }

  getTotals() {
    return this.totals();
  }
}

function tokenInt(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
