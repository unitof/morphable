/*
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

(function (scope) {
  if (scope['Proxy']) {
    return;
  }
  var lastRevokeFn = null;

  /**
   * @param {*} o
   * @return {boolean} whether this is probably a (non-null) Object
   */
  function isObject(o) {
    return o ? (typeof o === 'undefined' ? 'undefined' : _typeof(o)) === 'object' || typeof o === 'function' : false;
  }

  scope.Reflect = {
    get: function get(target, key) {
      return target[key];
    },
    set: function set(target, key, value) {
      return target[key] = value;
    },
    getOwnPropertyDescriptor: function getOwnPropertyDescriptor(target, key) {
      return Object.getOwnPropertyDescriptor(target, key);
    }

    /**
     * @constructor
     * @param {!Object} target
     * @param {{apply, construct, get, set}} handler
     */
  };scope.Proxy = function (target, handler) {
    if (!isObject(target) || !isObject(handler)) {
      if (!scope.Proxy.quiet) console.warn('Cannot create proxy with a non-object as target or handler');
    }

    // Construct revoke function, and set lastRevokeFn so that Proxy.revocable can steal it.
    // The caller might get the wrong revoke function if a user replaces or wraps scope.Proxy
    // to call itself, but that seems unlikely especially when using the polyfill.
    var throwRevoked = function throwRevoked() {};
    lastRevokeFn = function lastRevokeFn() {
      throwRevoked = function throwRevoked(trap) {
        if (!scope.Proxy.quiet) console.warn('Cannot perform \'' + trap + '\' on a proxy that has been revoked');
      };
    };

    // Fail on unsupported traps: Chrome doesn't do this, but ensure that users of the polyfill
    // are a bit more careful. Copy the internal parts of handler to prevent user changes.
    var unsafeHandler = handler;
    handler = { 'get': null, 'set': null, 'apply': null, 'construct': null };
    for (var k in unsafeHandler) {
      if (!(k in handler)) {
        if (!scope.Proxy.quiet) console.warn('Proxy polyfill does not support trap \'' + k + '\'');
      }
      handler[k] = unsafeHandler[k];
    }
    if (typeof unsafeHandler === 'function') {
      // Allow handler to be a function (which has an 'apply' method). This matches what is
      // probably a bug in native versions. It treats the apply call as a trap to be configured.
      handler.apply = unsafeHandler.apply.bind(unsafeHandler);
    }

    // Define proxy as this, or a Function (if either it's callable, or apply is set).
    // TODO(samthor): Closure compiler doesn't know about 'construct', attempts to rename it.
    var proxy = this;
    var isMethod = false;
    var isArray = false;
    if (typeof target === 'function') {
      proxy = function Proxy() {
        var usingNew = this && this.constructor === proxy;
        var args = Array.prototype.slice.call(arguments);
        throwRevoked(usingNew ? 'construct' : 'apply');

        if (usingNew && handler['construct']) {
          return handler['construct'].call(this, target, args);
        } else if (!usingNew && handler.apply) {
          return handler.apply(target, this, args);
        }

        // since the target was a function, fallback to calling it directly.
        if (usingNew) {
          // inspired by answers to https://stackoverflow.com/q/1606797
          args.unshift(target); // pass class as first arg to constructor, although irrelevant
          // nb. cast to convince Closure compiler that this is a constructor
          var f = /** @type {!Function} */target.bind.apply(target, args);
          return new f();
        }
        return target.apply(this, args);
      };
      isMethod = true;
    } else if (target instanceof Array) {
      proxy = [];
      isArray = true;
    }

    // Create default getters/setters. Create different code paths as handler.get/handler.set can't
    // change after creation.
    var getter = handler.get ? function (prop) {
      throwRevoked('get');
      if (this[prop] instanceof Array && !this[prop].__patched) {
        var arr = this[prop];
        var keys = ["pop", "push", "shift", "unshift", "splice", "reverse", "sort", "copyWithin", "fill"];

        keys.forEach(function (key) {
          var fn = Array.prototype[key];
          arr[key] = function () {
            var ret = fn.apply(arr, arguments);
            proxy[prop] = Array.from(arr);
            return ret;
          };
        });

        arr.__patched = true;
      }

      var ret = handler.get(this, prop, proxy);

      return ret;
    } : function (prop) {
      throwRevoked('get');
      return this[prop];
    };
    var setter = handler.set ? function (prop, value) {
      var status = handler.set(this, prop, value, proxy);
      if (!status) {
        // TODO(samthor): If the calling code is in strict mode, throw TypeError.
        // It's (sometimes) possible to work this out, if this code isn't strict- try to load the
        // callee, and if it's available, that code is non-strict. However, this isn't exhaustive.
      }
    } : function (prop, value) {
      throwRevoked('set');
      this[prop] = value;
    };

    // Clone direct properties (i.e., not part of a prototype).
    var propertyNames = Object.getOwnPropertyNames(target);
    var propertyMap = {};
    propertyNames.forEach(function (prop) {
      if ((isMethod || isArray) && prop in proxy) {
        return; // ignore properties already here, e.g. 'bind', 'prototype' etc
      }
      var real = Object.getOwnPropertyDescriptor(target, prop);
      var desc = {
        enumerable: !!real.enumerable,
        get: getter.bind(target, prop),
        set: setter.bind(target, prop)
      };
      Object.defineProperty(proxy, prop, desc);
      propertyMap[prop] = true;
    });

    // Set the prototype, or clone all prototype methods (always required if a getter is provided).
    // TODO(samthor): We don't allow prototype methods to be set. It's (even more) awkward.
    // An alternative here would be to _just_ clone methods to keep behavior consistent.
    var prototypeOk = true;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(proxy, Object.getPrototypeOf(target));
    } else if (proxy.__proto__) {
      proxy.__proto__ = target.__proto__;
    } else {
      prototypeOk = false;
    }
    if (handler.get || !prototypeOk) {
      for (var _k in target) {
        if (propertyMap[_k]) {
          continue;
        }
        Object.defineProperty(proxy, _k, { get: getter.bind(target, _k) });
      }
    }

    // The Proxy polyfill cannot handle adding new properties. Seal the target and proxy.
    // Object.seal(target);
    Object.seal(proxy);

    return proxy; // nb. if isMethod is true, proxy != this
  };

  scope.Proxy.revocable = function (target, handler) {
    var p = new scope.Proxy(target, handler);
    return { 'proxy': p, 'revoke': lastRevokeFn };
  };

  scope.Proxy['revocable'] = scope.Proxy.revocable;
  scope['Proxy'] = scope.Proxy;
})(typeof process !== 'undefined' && {}.toString.call(process) === '[object process]' ? global : self);

// goal: patch that proxifies all subobjects on get in order to (1) intercept method calls, (2) detect mutations, and (3) emulate mutation.
// problems: (1) array is not proxified and (2) prototype methods do not propagate through get handler
function patch(obj) {
  if ((typeof obj === 'undefined' ? 'undefined' : _typeof(obj)) !== 'object') return obj;
  var patched = new Proxy(obj, {
    get: function get(target, key) {
      console.log('get', Array.from(arguments));
      return patch(target[key]);
    },
    set: function set(target, key, val) {
      console.log('set', Array.from(arguments));
      return target[key] = patch(val);
    },
    apply: function apply(target, self, args) {
      console.log('apply', Array.from(arguments));
      // return target.apply(self, args)
    }
  });
  console.log('patching', obj, patched);
  return patched;
}
