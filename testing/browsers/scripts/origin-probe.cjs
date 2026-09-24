const pkg = require("/www1/navigator/node_modules/ws");
function probe(origin) {
  return new Promise((res) => {
    const ws = new pkg(`ws://127.0.0.1:9226/session`, { origin, handshakeTimeout: 3000 });
    let out = "";
    ws.on("open", () => { out = "OPEN (origin accepted)"; ws.close(); res(out); });
    ws.on("unexpected-response", (req, resp) => { out = "REJECTED " + resp.statusCode; res(out); });
    ws.on("error", (e) => { res("ERR " + (out || e.message)); });
    setTimeout(() => { if (!out) res("TIMEOUT"); }, 5000);
  });
}
(async () => {
  console.log("fake    11111111-2222-3333-4444-555555555555 ->", await probe("moz-extension://11111111-2222-3333-4444-555555555555"));
  console.log("derived 9d836749-720b-5b50-8fc0-e0709a90abed ->", await probe("moz-extension://9d836749-720b-5b50-8fc0-e0709a90abed"));
  process.exit(0);
})();
