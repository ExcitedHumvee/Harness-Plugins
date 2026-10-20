/**
 * Node half of the live-terminal plugin.
 *
 * The browser half renders the terminal window; this half is its data source.
 * It listens to the `jobs` registry — every terminal command the agent runs
 * registers there with its owning session, its command label, its start time,
 * its status, and a live output ring — and keeps one bounded record per
 * session so the window can show the newest command and its streamed output.
 *
 * The records are served over a read-only JSON route. The route carries only
 * command text and that command's own output, which the user already sees in
 * the transcript, and it is mounted only when a Web carrier exists.
 *
 * @module dsh-live-terminal
 */

/** Route the browser half polls. Plugin-prefixed so it cannot collide. */
export const ROUTE_PATH = '/dsh-live-terminal';

/** Job kinds that mean "the agent ran a terminal command". */
const COMMAND_KINDS = new Set(['bash', 'pwsh', 'terminal']);

/** Terminal job statuses. */
const TERMINAL_STATUSES = new Set(['completed', 'killed', 'failed']);

/** Commands retained per session (newest first); older settled ones are dropped. */
const HISTORY_LIMIT = 6;
/** Characters of live output retained per command record. */
const OUTPUT_LIMIT = 120_000;

/**
 * Append ring chunks to a record's retained output, keeping only its tail.
 *
 * @param {object} record - the command record to grow.
 * @param {ReadonlyArray<{text: string, gapBefore?: boolean}>} chunks - ring chunks.
 * @param {number} limit - retained character budget.
 */
function appendChunks(record, chunks, limit) {
  if (chunks.length === 0) return;
  let text = record.output;
  for (const chunk of chunks) {
    if (chunk.gapBefore === true) text += '\n… (earlier output dropped by the harness)\n';
    text += chunk.text;
  }
  if (text.length > limit) {
    text = text.slice(text.length - limit);
    record.truncated = true;
  }
  record.output = text;
}

/** One session's records, keyed by job id and ordered by registration. */
class SessionFeed {
  constructor() {
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.order = 0;
  }

  /**
   * Create a record for a newly registered job.
   *
   * @param {object} job - the live `JobView`.
   * @returns {object} the new record.
   */
  create(job) {
    const record = {
      id: job.id,
      kind: job.kind,
      command: job.label,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      detail: job.detail ?? null,
      output: '',
      truncated: false,
      order: this.order++,
    };
    this.records.set(job.id, record);
    this.trim();
    return record;
  }

  /**
   * Refresh a record from the job's current projection.
   *
   * @param {object} job - the live `JobView`.
   * @returns {object | undefined} the refreshed record.
   */
  refresh(job) {
    const record = this.records.get(job.id);
    if (record === undefined) return undefined;
    record.command = job.label;
    record.status = job.status;
    record.startedAt = job.startedAt;
    record.finishedAt = job.finishedAt ?? record.finishedAt;
    record.detail = job.detail ?? record.detail;
    return record;
  }

  /** Settled records first, oldest first. */
  settled() {
    return [...this.records.values()]
      .filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort((a, b) => a.order - b.order);
  }

  /** Keep at most HISTORY_LIMIT records, preferring to drop settled ones. */
  trim() {
    while (this.records.size > HISTORY_LIMIT) {
      const oldest = this.settled()[0];
      if (oldest === undefined) break;
      this.records.delete(oldest.id);
    }
    while (this.records.size > HISTORY_LIMIT) {
      const oldest = [...this.records.values()].sort((a, b) => a.order - b.order)[0];
      this.records.delete(oldest.id);
    }
  }
}

/**
 * Host plugin body.
 *
 * @param {import('cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  /** @type {Map<string, SessionFeed>} */
  const feeds = new Map();
  /** Ring offset already folded into each record, per job id. */
  const cursors = new Map();
  /** Latest `JobView` per job id, so an `output` event can resolve its owner. */
  const jobs = new Map();

  /** @param {string} sessionId */
  const feedOf = (sessionId) => {
    let feed = feeds.get(sessionId);
    if (feed === undefined) {
      feed = new SessionFeed();
      feeds.set(sessionId, feed);
    }
    return feed;
  };

  /**
   * Read a job's ring from the recorded offset and fold it into its record.
   *
   * @param {object} registry - the jobs service.
   * @param {string} sessionId - the owning session.
   * @param {string} jobId - the job to drain.
   */
  const drain = (registry, sessionId, jobId) => {
    const record = feeds.get(sessionId)?.records.get(jobId);
    if (record === undefined) return;
    const from = cursors.get(jobId) ?? 0;
    let read;
    try {
      read = registry.readAt(jobId, from, sessionId);
    } catch {
      return; // the registry dropped the job; the retained text stays.
    }
    appendChunks(record, read.chunks ?? [], OUTPUT_LIMIT);
    cursors.set(jobId, read.next ?? from);
  };

  ctx.inject(['jobs'], (jobCtx) => {
    const registry = jobCtx.jobs;
    jobCtx.effect(
      () =>
        registry.events.subscribe({ owners: 'all' }, (event) => {
          const view = event.job ?? jobs.get(event.id);
          if (view !== undefined) jobs.set(view.id, view);

          if (event.type === 'output') {
            if (event.owner === undefined) return;
            drain(registry, event.owner, event.id);
            return;
          }

          if (view === undefined) return;
          const owner = view.owner;
          if (owner === undefined) return;

          if (event.type === 'registered') {
            if (!COMMAND_KINDS.has(view.kind)) return;
            feedOf(owner).create(view);
            return;
          }

          const record = feeds.get(owner)?.refresh(view);
          if (record === undefined) return;
          if (event.type === 'settled') {
            drain(registry, owner, view.id);
            jobs.delete(view.id);
          }
        }),
      'live-terminal: job listener',
    );
  });

  /**
   * Build the snapshot served to the page.
   *
   * @param {string} sessionId - the browser's session.
   */
  const snapshot = (sessionId) => {
    const records = [...(feeds.get(sessionId)?.records.values() ?? [])].sort((a, b) => b.order - a.order);
    const active = records.find((record) => !TERMINAL_STATUSES.has(record.status)) ?? null;
    return {
      sessionId,
      active,
      recent: records.filter((record) => record.id !== active?.id),
      serverTime: Date.now(),
    };
  };

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler: (req, res) => {
            const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost');
            const sessionId = url.searchParams.get('sessionId') ?? '';
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(snapshot(sessionId)));
          },
        }),
      'live-terminal: snapshot route',
    );
  });

  ctx.effect(
    () => () => {
      feeds.clear();
      cursors.clear();
      jobs.clear();
    },
    'live-terminal: records',
  );
}
