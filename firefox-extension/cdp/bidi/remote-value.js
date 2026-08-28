/**
 * BiDi <-> CDP value transcoding.
 *
 * WebDriver BiDi `script.evaluate`/`script.callFunction` return *remote values*
 * ({ type, value, objectId? }), not raw JSON. Navigators speaks CDP, whose
 * Runtime.evaluate returns RemoteObjects ({ type, value, subtype?, description?,
 * objectId? }). This module is the pure translator between the two. No
 * browser.* dependency — unit-testable in the vm harness.
 */
var RuntimeResult = (function() {
  'use strict';

  /** Recursively unwrap a BiDi remote value into plain JS. */
  function deserialize(remoteValue) {
    if (!remoteValue || typeof remoteValue !== 'object') return remoteValue;
    var t = remoteValue.type;
    switch (t) {
      case 'string':
      case 'number':
      case 'boolean':
        return remoteValue.value;
      case 'bigint':
        return remoteValue.value; // string form
      case 'undefined':
      case 'null':
        return t === 'null' ? null : undefined;
      case 'array':
        return (remoteValue.value || []).map(deserialize);
      case 'object':
      case 'map':
      case 'set': {
        var out = t === 'set' ? [] : {};
        (remoteValue.value || []).forEach(function(pair) {
          if (t === 'set') { out.push(deserialize(pair)); return; }
          var k = pair && pair[0];
          var v = pair && pair[1];
          try { out[deserialize(k)] = deserialize(v); } catch (e) { out[String(k)] = deserialize(v); }
        });
        return out;
      }
      case 'regexp':
      case 'date':
        return remoteValue.value || '';
      case 'node':
      case 'window':
      case 'function':
        return remoteValue.value || null;
      default:
        return remoteValue.value;
    }
  }

  /** Map one BiDi remote value -> CDP RemoteObject-ish shape. */
  function toCdp(remoteValue) {
    if (!remoteValue || typeof remoteValue !== 'object') {
      return { type: typeof remoteValue, value: remoteValue };
    }
    var t = remoteValue.type;
    var obj = { type: t };
    if (remoteValue.objectId) obj.objectId = remoteValue.objectId;

    switch (t) {
      case 'undefined':
        obj.type = 'undefined';
        break;
      case 'null':
        obj.type = 'object';
        obj.subtype = 'null';
        obj.value = null;
        break;
      case 'bigint':
        obj.type = 'bigint';
        obj.subtype = 'bigint';
        obj.value = remoteValue.value;
        obj.description = remoteValue.value + 'n';
        break;
      case 'string':
      case 'number':
      case 'boolean':
        obj.value = remoteValue.value;
        break;
      case 'array':
        obj.type = 'object';
        obj.subtype = 'array';
        obj.value = (remoteValue.value || []).map(toCdp).map(function(o) { return o.value; });
        obj.description = 'Array(' + (remoteValue.value || []).length + ')';
        break;
      case 'map':
        obj.type = 'object';
        obj.subtype = 'map';
        obj.value = deserialize(remoteValue);
        obj.description = 'Map';
        break;
      case 'set':
        obj.type = 'object';
        obj.subtype = 'set';
        obj.value = deserialize(remoteValue);
        obj.description = 'Set';
        break;
      case 'object': {
        obj.type = 'object';
        if (remoteValue.value && remoteValue.value.length) {
          var plain = {};
          remoteValue.value.forEach(function(pair) {
            plain[deserialize(pair[0])] = deserialize(pair[1]);
          });
          obj.value = plain;
          obj.description = 'Object';
        } else {
          obj.value = {};
        }
        break;
      }
      case 'regexp':
        obj.type = 'object';
        obj.subtype = 'regexp';
        obj.description = String((remoteValue.value && remoteValue.value.pattern) || '');
        break;
      case 'date':
        obj.type = 'object';
        obj.subtype = 'date';
        obj.description = String(remoteValue.value || '');
        break;
      case 'function':
        obj.type = 'function';
        obj.description = 'function () { [native code] }';
        obj.value = undefined;
        break;
      case 'node':
        obj.type = 'object';
        obj.subtype = 'node';
        obj.description = (remoteValue.value && remoteValue.value.localName) || 'Node';
        break;
      case 'window':
        obj.type = 'object';
        obj.subtype = 'window';
        break;
      default:
        obj.value = remoteValue.value;
    }
    return obj;
  }

  /** Wrap a full script.evaluate/script.callFunction success/exception payload. */
  function toCdpResult(bidiPayload) {
    if (!bidiPayload) return { result: toCdp({ type: 'undefined' }) };
    if (bidiPayload.type === 'exception') {
      var ed = bidiPayload.exceptionDetails || {};
      return {
        result: toCdp({ type: 'undefined' }),
        exceptionDetails: {
          text: ed.text || 'Uncaught exception',
          lineNumber: ed.lineNumber || 0,
          columnNumber: ed.columnNumber || 0,
          exception: toCdp(ed.exception)
        }
      };
    }
    return { result: toCdp(bidiPayload.result) };
  }

  /**
   * Extract the plain JS value a script.evaluate result delivered via a JSON
   * string (used by the injected DOM walker). Returns null on failure.
   */
  function plainValue(bidiPayload) {
    if (!bidiPayload || bidiPayload.type !== 'success') return null;
    var r = bidiPayload.result;
    if (!r) return null;
    if (r.type === 'string') {
      try { return JSON.parse(r.value); } catch (e) { return null; }
    }
    return deserialize(r);
  }

  /** Plain JS value -> BiDi remote value (for script.callFunction arguments). */
  function plainToRemoteValue(v) {
    if (v === null) return { type: 'null' };
    if (v === undefined) return { type: 'undefined' };
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return { type: t, value: v };
    if (t === 'bigint') return { type: 'bigint', value: String(v) };
    if (Array.isArray(v)) {
      return { type: 'array', value: v.map(plainToRemoteValue) };
    }
    if (t === 'object') {
      var pairs = Object.keys(v).map(function(k) {
        return [k, plainToRemoteValue(v[k])];
      });
      return pairs.length ? { type: 'object', value: pairs } : { type: 'object', value: [] };
    }
    return { type: 'undefined' };
  }

  /** CDP Runtime.callFunctionOn argument -> BiDi script.callFunction argument. */
  function cdpArgToBidi(arg) {
    if (!arg) return plainToRemoteValue(undefined);
    if (arg.unserializableValue !== undefined) {
      if (arg.unserializableValue === 'BigInt') {
        return { type: 'bigint', value: arg.value != null ? String(arg.value) : '0' };
      }
    }
    if (arg.objectId) {
      // Phase 2: object handles need realm-scoped BiDi handles; not portable.
      return null;
    }
    return plainToRemoteValue(arg.value);
  }

  return {
    deserialize: deserialize,
    toCdp: toCdp,
    toCdpResult: toCdpResult,
    plainValue: plainValue,
    plainToRemoteValue: plainToRemoteValue,
    cdpArgToBidi: cdpArgToBidi
  };
})();