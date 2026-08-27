const WEB_FETCH_TIMEOUT_CODE = "WEB_FETCH_TIMEOUT";
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;

export class WebFetchTimeoutError extends Error {
  constructor(message, { phase, timeoutMs } = {}) {
    super(message);
    this.name = "WebFetchTimeoutError";
    this.code = WEB_FETCH_TIMEOUT_CODE;
    this.phase = phase || "operation";
    this.timeoutMs = timeoutMs;
  }
}

export function isWebFetchTimeout(error) {
  return error?.code === WEB_FETCH_TIMEOUT_CODE;
}

export class WebFetchOperation {
  constructor({ url, stepTimeoutMs, totalTimeoutMs, closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS }) {
    this.url = url;
    this.closeTimeoutMs = Math.max(1, Number(closeTimeoutMs) || DEFAULT_CLOSE_TIMEOUT_MS);
    this.startedAt = Date.now();
    this.controller = new AbortController();
    this.page = null;
    this.closePromise = null;
    this.timeoutError = null;
    this.overallTimer = null;

    this.abortPromise = new Promise((_, reject) => {
      this.rejectAbort = reject;
    });
    this.abortPromise.catch(() => {});

    this.configureTimeouts({ stepTimeoutMs, totalTimeoutMs });
  }

  configureTimeouts({ stepTimeoutMs, totalTimeoutMs }) {
    if (this.signal.aborted) return;
    this.stepTimeoutMs = Math.max(1, Number(stepTimeoutMs) || 1);
    this.totalTimeoutMs = Math.max(this.stepTimeoutMs, Number(totalTimeoutMs) || this.stepTimeoutMs);
    clearTimeout(this.overallTimer);

    const onTimeout = () => {
      this.abort(new WebFetchTimeoutError(
        `Open page operation timed out after ${this.totalTimeoutMs}ms`,
        { phase: "overall", timeoutMs: this.totalTimeoutMs }
      ));
    };
    const remainingMs = this.remainingMs();
    if (remainingMs === 0) {
      onTimeout();
      return;
    }
    this.overallTimer = setTimeout(onTimeout, remainingMs);
  }

  get signal() {
    return this.controller.signal;
  }

  get timedOut() {
    return isWebFetchTimeout(this.timeoutError);
  }

  remainingMs() {
    return Math.max(0, this.totalTimeoutMs - (Date.now() - this.startedAt));
  }

  throwIfAborted() {
    if (!this.signal.aborted) return;
    throw this.signal.reason || this.timeoutError || new Error("web_fetch operation aborted");
  }

  abort(error) {
    if (this.signal.aborted) return false;
    this.timeoutError = error;
    this.controller.abort(error);
    this.rejectAbort(error);
    void this.closePage(`timeout:${error?.phase || "operation"}`);
    return true;
  }

  async run(task) {
    this.throwIfAborted();
    const taskPromise = Promise.resolve().then(task);
    return Promise.race([taskPromise, this.abortPromise]);
  }

  async wait(label, task, { onLateResolve } = {}) {
    this.throwIfAborted();
    const taskPromise = Promise.resolve().then(task);

    if (onLateResolve) {
      taskPromise.then((value) => {
        if (!this.signal.aborted) return;
        Promise.resolve(onLateResolve(value)).catch((error) => {
          console.error(`[web_fetch] late ${label} cleanup failed: ${String(error?.message || error)}`);
        });
      }, () => {});
    }

    return Promise.race([taskPromise, this.abortPromise]);
  }

  async step(label, task, { timeoutMs = this.stepTimeoutMs, onLateResolve } = {}) {
    this.throwIfAborted();
    const stepTimeoutMs = Math.max(1, Number(timeoutMs) || this.stepTimeoutMs);
    const remainingMs = this.remainingMs();
    let timeoutId;

    if (stepTimeoutMs < remainingMs) {
      timeoutId = setTimeout(() => {
        this.abort(new WebFetchTimeoutError(
          `Open page step timed out (${label}) after ${stepTimeoutMs}ms`,
          { phase: label, timeoutMs: stepTimeoutMs }
        ));
      }, stepTimeoutMs);
    }

    try {
      return await this.wait(label, task, { onLateResolve });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async openPage(task) {
    const resolved = await this.step("new_page", task, {
      onLateResolve: (late) => {
        const latePage = late?.page || late;
        this.page = latePage;
        return this.closePage("late_new_page");
      }
    });
    const page = resolved?.page || resolved;
    this.page = page;
    if (this.signal.aborted) {
      void this.closePage("late_new_page");
      this.throwIfAborted();
    }
    return resolved;
  }

  closePage(reason = "operation_complete") {
    const page = this.page;
    if (!page) return Promise.resolve(true);
    if (this.closePromise) return this.closePromise;

    try {
      if (page.isClosed()) return Promise.resolve(true);
    } catch {
      // Attempt the close when page state cannot be read.
    }

    this.closePromise = new Promise((resolve) => {
      let settled = false;
      const finish = (closed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(closed);
      };
      const timeoutId = setTimeout(() => {
        if (settled) return;
        console.error(`⏱️  page.close() exceeded ${this.closeTimeoutMs}ms (${reason}) ${this.url} — target left for browser cleanup`);
        finish(false);
      }, this.closeTimeoutMs);

      Promise.resolve()
        .then(() => page.close())
        .then(
          () => finish(true),
          (error) => {
            if (settled) return;
            console.error(`⏱️  page.close() failed (${reason}) ${this.url}: ${String(error?.message || error)}`);
            finish(false);
          }
        );
    });

    return this.closePromise;
  }

  async finish(reason = "operation_complete") {
    clearTimeout(this.overallTimer);
    if (this.timedOut) {
      void this.closePage(reason);
      return;
    }
    await this.closePage(reason);
  }

  dispose() {
    clearTimeout(this.overallTimer);
  }
}
