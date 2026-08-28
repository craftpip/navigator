var Logger = {
  DEBUG_TAG: '[Navigator Relay FX]',

  log: function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(Logger.DEBUG_TAG);
    console.log.apply(console, args);
  },
  info: function() {
    Logger.log.apply(Logger, arguments);
  },
  warn: function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(Logger.DEBUG_TAG);
    console.warn.apply(console, args);
  },
  error: function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(Logger.DEBUG_TAG);
    console.error.apply(console, args);
  }
};