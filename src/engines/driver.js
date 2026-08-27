export const POOL_POLICIES = new Set(["engine", "shared"]);

export class SearchEngineDriver {
  id = "";
  pool = null;
  homeUrl = null;
  inputSelectors = [];
  resultSelectors = [];

  constructor(config = {}) {
    this.config = config;
  }

  get isBrowser() {
    return this.pool !== null;
  }

  searchUrl(_query) {
    throw new Error(`${this.id} does not implement searchUrl()`);
  }

  async search(_params) {
    throw new Error(`${this.id} does not implement search()`);
  }

  async submit(_page, _query) {
    throw new Error(`${this.id} does not implement submit()`);
  }

  async extract(_page) {
    throw new Error(`${this.id} does not implement extract()`);
  }

  async assertNotBlocked(_page) {}
}
