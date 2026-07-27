/**
 * Source of the script injected into the preview page, served by the bridge at
 * GET /preview-console.js.
 *
 * Delivery constraints that shape it:
 *   - it must not need a preflight, or the browser would OPTIONS every batch: the POST goes
 *     out as `text/plain`, which keeps it a CORS "simple request";
 *   - it must never call the real console, directly or through a throw, or a failure to ship
 *     logs would itself generate logs and loop;
 *   - it must survive the bridge being down (Cocos closed): failures back off and the page
 *     is otherwise untouched.
 */

export interface PreviewClientOptions {
    port: number;
    host?: string;
    /** Flush cadence, ms. */
    flushMs?: number;
    /** Entries buffered page-side before the oldest are dropped. */
    maxQueue?: number;
}

export function previewConsoleClient(opts: PreviewClientOptions): string {
    const host = opts.host || '127.0.0.1';
    const endpoint = `http://${host}:${opts.port}/preview-log`;
    const flushMs = opts.flushMs ?? 300;
    const maxQueue = opts.maxQueue ?? 500;

    return `/* cocos-mcp-server preview console bridge — dev only, served from ${endpoint} */
(function () {
    'use strict';
    if (window.__MCP_PREVIEW_CONSOLE__) { return; }
    window.__MCP_PREVIEW_CONSOLE__ = true;

    var ENDPOINT = ${JSON.stringify(endpoint)};
    var FLUSH_MS = ${flushMs};
    var MAX_QUEUE = ${maxQueue};
    var MAX_ARG_CHARS = 2000;
    var MAX_DEPTH = 3;

    var session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    window.__MCP_PREVIEW_SESSION__ = session;

    var queue = [];
    var dropped = 0;
    var timer = null;
    var failures = 0;
    var sending = false;

    function ctorName(v) {
        try { return (v && v.constructor && v.constructor.name) || 'Object'; } catch (e) { return 'Object'; }
    }

    // cc.Node / cc.Component / cc.Asset would serialise the whole scene graph, so anything
    // carrying a uuid is named rather than expanded.
    function isEngineObject(v) {
        return !!v && typeof v === 'object' && typeof v.uuid === 'string';
    }

    function preview(v, depth, seen) {
        if (v === null) { return 'null'; }
        var t = typeof v;
        if (t === 'undefined') { return 'undefined'; }
        if (t === 'string') { return depth === 0 ? v : JSON.stringify(v); }
        if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') { return String(v); }
        if (t === 'function') { return '[function ' + (v.name || 'anonymous') + ']'; }
        if (v instanceof Error) { return (v.name || 'Error') + ': ' + v.message; }
        if (seen.indexOf(v) !== -1) { return '[circular]'; }
        if (isEngineObject(v)) { return '[' + ctorName(v) + ' ' + (v.name || v.uuid) + ']'; }
        if (depth >= MAX_DEPTH) {
            return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[' + ctorName(v) + ']';
        }
        seen.push(v);
        try {
            if (Array.isArray(v)) {
                var items = [];
                for (var i = 0; i < v.length && i < 20; i++) { items.push(preview(v[i], depth + 1, seen)); }
                if (v.length > 20) { items.push('… +' + (v.length - 20) + ' more'); }
                return '[' + items.join(', ') + ']';
            }
            var keys;
            try { keys = Object.keys(v); } catch (e) { return '[' + ctorName(v) + ']'; }
            var parts = [];
            for (var k = 0; k < keys.length && k < 20; k++) {
                parts.push(keys[k] + ': ' + preview(v[keys[k]], depth + 1, seen));
            }
            if (keys.length > 20) { parts.push('… +' + (keys.length - 20) + ' more'); }
            var name = ctorName(v);
            var body = '{' + parts.join(', ') + '}';
            return name === 'Object' ? body : name + ' ' + body;
        } catch (e) {
            return '[unserialisable ' + ctorName(v) + ']';
        } finally {
            seen.pop();
        }
    }

    function fmt(args) {
        var out = [];
        for (var i = 0; i < args.length; i++) {
            var s;
            try { s = preview(args[i], 0, []); } catch (e) { s = '[unserialisable]'; }
            if (s.length > MAX_ARG_CHARS) { s = s.slice(0, MAX_ARG_CHARS) + '… [+' + (s.length - MAX_ARG_CHARS) + ' chars]'; }
            out.push(s);
        }
        return out.join(' ');
    }

    function push(level, message, stack) {
        if (queue.length >= MAX_QUEUE) { queue.shift(); dropped++; }
        queue.push({ level: level, message: message, stack: stack, ts: Date.now() });
        schedule();
    }

    function schedule() {
        if (timer !== null) { return; }
        var delay = failures ? Math.min(FLUSH_MS * Math.pow(2, failures), 15000) : FLUSH_MS;
        timer = setTimeout(function () { timer = null; flush(false); }, delay);
    }

    function payload(batch) {
        var head = batch;
        if (dropped) {
            head = [{ level: 'warn', message: '[preview-console] dropped ' + dropped + ' entries (page-side buffer full)', ts: Date.now() }].concat(batch);
            dropped = 0;
        }
        return JSON.stringify({ session: session, url: location.href, entries: head });
    }

    function flush(useBeacon) {
        if (sending || !queue.length) { return; }
        var batch = queue;
        queue = [];
        var body = payload(batch);

        if (useBeacon && navigator.sendBeacon) {
            // Blob type keeps it a simple request; sendBeacon survives page unload.
            try {
                if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) { return; }
            } catch (e) { /* fall through to fetch */ }
        }

        sending = true;
        fetch(ENDPOINT, {
            method: 'POST',
            body: body,
            headers: { 'Content-Type': 'text/plain' },
            keepalive: body.length < 60000,
            mode: 'cors'
        }).then(function () {
            failures = 0;
        }).catch(function () {
            // Bridge down (Cocos closed). Put the batch back, bounded, and back off.
            failures++;
            if (queue.length < MAX_QUEUE) {
                queue = batch.slice(Math.max(0, batch.length - (MAX_QUEUE - queue.length))).concat(queue);
            }
        }).then(function () {
            sending = false;
            if (queue.length) { schedule(); }
        });
    }

    var METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    for (var m = 0; m < METHODS.length; m++) {
        (function (name) {
            var original = console[name];
            if (typeof original !== 'function') { return; }
            var level = name === 'trace' ? 'debug' : name;
            console[name] = function () {
                try { push(level, fmt(arguments)); } catch (e) { /* never let logging break the page */ }
                return original.apply(console, arguments);
            };
        })(METHODS[m]);
    }

    window.addEventListener('error', function (ev) {
        try {
            var where = ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ':' + ev.colno + ')' : '';
            var msg = (ev.error && ev.error.message) || ev.message || 'unknown error';
            push('error', 'Uncaught ' + msg + where, ev.error && ev.error.stack);
        } catch (e) { /* ignore */ }
    });

    window.addEventListener('unhandledrejection', function (ev) {
        try {
            var r = ev.reason;
            var msg = (r && r.message) || String(r);
            push('error', 'Unhandled promise rejection: ' + msg, r && r.stack);
        } catch (e) { /* ignore */ }
    });

    window.addEventListener('pagehide', function () { flush(true); });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { flush(true); }
    });

    push('info', '[preview-console] attached, session ' + session + ' at ' + location.href);
})();
`;
}
