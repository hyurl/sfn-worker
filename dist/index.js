"use strict";
var tslib_1 = require("tslib");
require("source-map-support/register");
var events_1 = require("events");
var cluster = require("cluster");
var bluebird = require("bluebird");
var values = require("lodash/values");
var filter = require("lodash/filter");
var ClusterWorkers = {};
var Workers = {};
var MaxListeners = 0;
var isNode6 = parseInt(process.version.slice(1)) >= 6;
var WorkerPids = {};
var Worker = /** @class */ (function (_super) {
    tslib_1.__extends(Worker, _super);
    /**
     * @param id An unique ID of the worker.
     * @param keepAlive If `true`, when the worker process accidentally exits,
     *  create a new one to replace it immediately. default is `false`.
     */
    function Worker(id, keepAlive) {
        if (keepAlive === void 0) { keepAlive = false; }
        var _this = _super.call(this) || this;
        _this.state = "connecting";
        _this.receivers = [];
        _this.id = id;
        _this.keepAlive = keepAlive;
        if (cluster.isMaster && (!Workers[id] || Workers[id].state == "closed"))
            createWorker(_this);
        return _this;
    }
    /** Whether the worker process is connected (`online`). */
    Worker.prototype.isConnected = function () {
        return this.state == "online";
    };
    /** Whether the worker process is dead (`closed`). */
    Worker.prototype.isDead = function () {
        return this.state == "closed";
    };
    Worker.prototype.on = function (event, listener) {
        var _this = this;
        if (cluster.isMaster) {
            if (event == "error" || event == "exit") {
                _super.prototype.on.call(this, event, listener);
            }
            else {
                cluster.on("message", function (worker, msg) {
                    msg = isNode6 ? msg : worker;
                    if (msg && msg.id == _this.id && msg.event == event) {
                        listener.call.apply(listener, [_this].concat(msg.data));
                    }
                });
            }
        }
        else {
            process.on(event, listener);
        }
        return this;
    };
    Worker.prototype.once = function (event, listener) {
        var _this = this;
        if (cluster.isMaster) {
            if (event == "error" || event == "exit") {
                _super.prototype.once.call(this, event, listener);
            }
            else {
                cluster.once("message", function (worker, msg) {
                    msg = isNode6 ? msg : worker;
                    if (msg && msg.id == _this.id && msg.event == event) {
                        listener.call.apply(listener, [_this].concat(msg.data));
                    }
                });
            }
        }
        else {
            process.once(event, listener);
        }
        return this;
    };
    /**
     * Emits an event to the other end of the worker.
     * @param data A list of data, they will be received by event listeners.
     */
    Worker.prototype.emit = function (event) {
        var data = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            data[_i - 1] = arguments[_i];
        }
        if (event == "online")
            return false;
        if (cluster.isMaster) {
            if (event == "error" || event == "exit") {
                _super.prototype.emit.apply(this, [event].concat(data));
            }
            else if (this.receivers.length) {
                for (var _a = 0, _b = this.receivers; _a < _b.length; _a++) {
                    var id = _b[_a];
                    if (ClusterWorkers[id])
                        ClusterWorkers[id].send({ event: event, data: data });
                }
                this.receivers = [];
            }
            else if (ClusterWorkers[this.id]) {
                ClusterWorkers[this.id].send({ event: event, data: data });
            }
        }
        else {
            if (event == "error" || event == "exit") {
                (_c = process.emit).call.apply(_c, [process, event].concat(data));
            }
            else if (this.receivers.length) {
                process.send({
                    id: this.id,
                    event: "----transmit----",
                    data: { receivers: this.receivers, event: event, data: data }
                });
                this.receivers = [];
            }
            else {
                process.send({ id: this.id, event: event, data: data });
            }
        }
        return true;
        var _c;
    };
    Worker.prototype.to = function () {
        var workers = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            workers[_i] = arguments[_i];
        }
        if (workers[0] instanceof Array) {
            workers = workers[0];
        }
        for (var i in workers) {
            // If workers are passed, then get their IDs.
            if (workers[i] instanceof Worker)
                workers[i] = workers[i].id;
        }
        this.receivers = this.receivers.concat(workers);
        return this;
    };
    /** Emits an event to all workers (the current one included). */
    Worker.prototype.broadcast = function (event) {
        var data = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            data[_i - 1] = arguments[_i];
        }
        if (event == "online" || event == "error" || event == "exit")
            return false;
        if (cluster.isMaster) {
            for (var id in ClusterWorkers) {
                ClusterWorkers[id].send({ event: event, data: data });
            }
        }
        else {
            process.send({
                id: this.id,
                event: "----broadcast----",
                data: { event: event, data: data }
            });
        }
        return true;
    };
    Worker.prototype.getWorkers = function (cb) {
        return this.constructor.getWorkers(cb);
    };
    /** Terminates the current worker. */
    Worker.prototype.exit = function () {
        if (cluster.isMaster) {
            ClusterWorkers[this.id].kill();
        }
        else {
            process.exit();
        }
    };
    /** Restarts the current worker. */
    Worker.prototype.reboot = function () {
        if (cluster.isMaster) {
            this.state = "closed";
            ClusterWorkers[this.id].send("----reboot----");
        }
        else {
            process.exit(826); // 826 indicates reboot code.
        }
    };
    Worker.prototype.setMaxListeners = function (n) {
        _super.prototype.setMaxListeners.call(this, n);
        if (cluster.isMaster) {
            var max = MaxListeners;
            for (var i in Workers) {
                if (Workers[i].isConnected())
                    max += Workers[i].getMaxListeners();
            }
            cluster.setMaxListeners(max);
        }
        else {
            process.setMaxListeners(n);
        }
        return this;
    };
    Worker.on = function (event, listener) {
        var _this = this;
        if (cluster.isMaster) {
            if (event == "online") {
                MaxListeners += 1;
                cluster.setMaxListeners(cluster.getMaxListeners() + 1);
                cluster.on("online", function (worker) {
                    var _a = WorkerPids[worker.process.pid], id = _a.id, reborn = _a.reborn;
                    if (!reborn) {
                        // Reborn workers do not emit this event.
                        listener(Workers[id]);
                    }
                });
            }
            else if (event == "exit") {
                MaxListeners += 1;
                cluster.setMaxListeners(cluster.getMaxListeners() + 1);
                cluster.on("exit", function (worker, code, signal) {
                    var _a = WorkerPids[worker.process.pid], id = _a.id, keepAlive = _a.keepAlive;
                    // Keep-alive workers only emit this event once.
                    if (!code || (code && !keepAlive)) {
                        listener(Workers[id], code, signal);
                    }
                });
            }
        }
        else {
            if (event == "online") {
                process.on("message", function (msg) {
                    if (msg && msg.event == event) {
                        var _a = msg.data[0], id = _a.id, keepAlive = _a.keepAlive;
                        if (!Workers[id]) {
                            // Initiate worker instance.
                            Workers[id] = new _this(id, keepAlive);
                            Workers[id].state = "online";
                            WorkerPids[process.pid] = {
                                id: id,
                                keepAlive: keepAlive,
                                reborn: false
                            };
                            // Emit event for Worker.getWorker().
                            process.emit("----online----", id);
                        }
                        listener(Workers[id]);
                    }
                });
            }
            else if (event == "exit") {
                process.on("exit", function (code, signal) {
                    var _a = WorkerPids[process.pid], id = _a.id, keepAlive = _a.keepAlive;
                    // Keep-alive workers only emit this event once.
                    if (!code || (code && !keepAlive)) {
                        listener(Workers[id], code, signal);
                    }
                });
            }
        }
        return this;
    };
    /**
     * (**master only**) Emits an event to some worker process(es). If you
     * don't call `Worker.to()` before calling this method, then it will act
     * the same as broadcast.
     */
    Worker.emit = function (event) {
        var data = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            data[_i - 1] = arguments[_i];
        }
        if (event == "online" || event == "error" || event == "exit")
            return false;
        if (cluster.isMaster) {
            if (!this.receivers.length) {
                return this.broadcast.apply(this, [event].concat(data));
            }
            else {
                for (var _a = 0, _b = this.receivers; _a < _b.length; _a++) {
                    var id = _b[_a];
                    if (ClusterWorkers[id])
                        ClusterWorkers[id].send({ event: event, data: data });
                }
                this.receivers = [];
            }
        }
        else {
            throw new ReferenceError("Cannot call static method '" + this["name"] + ".emit()' in a worker process.");
        }
        return true;
    };
    Worker.to = function () {
        var workders = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            workders[_i] = arguments[_i];
        }
        if (cluster.isMaster) {
            if (workders[0] instanceof Array) {
                workders = workders[0];
            }
            for (var i in workders) {
                // If workers are passed, then get their IDs.
                if (workders[i] instanceof Worker)
                    workders[i] = workders[i].id;
            }
            this.receivers = this.receivers.concat(workders);
        }
        else {
            throw new ReferenceError("Cannot call static method '" + this["name"] + ".to()' in a worker process.");
        }
        return this;
    };
    /** (**master only**) Emits an event to all workers (worker processes). */
    Worker.broadcast = function (event) {
        var data = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            data[_i - 1] = arguments[_i];
        }
        if (event == "online" || event == "error" || event == "exit")
            return false;
        if (cluster.isMaster) {
            for (var id in ClusterWorkers) {
                ClusterWorkers[id].send({ event: event, data: data });
            }
        }
        else {
            throw new ReferenceError("Cannot call static method '" + this["name"] + ".broadcast()' in a worker process.");
        }
        return true;
    };
    Worker.getWorkers = function (cb) {
        var _this = this;
        if (cb) {
            if (this.isMaster) {
                process.nextTick(function () {
                    cb(filter(values(Workers), function (worker) { return worker.isConnected(); }));
                });
            }
            else {
                var worker_1 = values(Workers)[0];
                if (worker_1) {
                    worker_1.once("----get-workers----", function (workers) {
                        for (var i in workers) {
                            if (workers[i].id == worker_1.id) {
                                workers[i] = worker_1;
                            }
                            else {
                                var state = workers[i].state;
                                workers[i] = new _this(workers[i].id, workers[i].keepAlive);
                                workers[i].state = state;
                            }
                        }
                        cb(workers);
                    }).emit("----get-workers----");
                }
                else {
                    process.once("----online----", function () {
                        _this.getWorkers(cb);
                    });
                }
            }
        }
        else {
            return new this.Promise(function (resolve) {
                _this.getWorkers(resolve);
            });
        }
    };
    Worker.getWorker = function (cb) {
        var _this = this;
        if (this.isMaster) {
            throw new Error("Cannot call static method '" + this["name"] + ".getWorker()' in the master process.");
        }
        if (cb) {
            var worker_2 = values(Workers)[0];
            if (worker_2) {
                process.nextTick(function () {
                    cb(worker_2);
                });
            }
            else {
                process.once("----online----", function (id) {
                    cb(Workers[id]);
                });
            }
        }
        else {
            return new this.Promise(function (resolve) {
                _this.getWorker(resolve);
            });
        }
    };
    Worker.Promise = isNode6 ? Promise : bluebird;
    Worker.receivers = [];
    return Worker;
}(events_1.EventEmitter));
(function (Worker) {
    /** Whether the process is the master. */
    Worker.isMaster = cluster.isMaster;
    /** Whether the process is a worker. */
    Worker.isWorker = cluster.isWorker;
})(Worker || (Worker = {}));
/** Creates worker process. */
function createWorker(target, reborn) {
    if (reborn === void 0) { reborn = false; }
    var id = target.id, keepAlive = target.keepAlive, worker = cluster.fork();
    if (reborn) {
        // when reborn, copy event listners and remove unused worker-pid pairs.
        target["_events"] = Workers[id]["_events"];
        target["_eventCount"] = Workers[id]["_eventCount"];
        target["_maxListeners"] = Workers[id]["_maxListeners"];
        // WorkerPids = filter(WorkerPids, data => data.id != target.id);
    }
    Workers[id] = target;
    ClusterWorkers[id] = worker;
    WorkerPids[worker.process.pid] = { id: id, keepAlive: keepAlive, reborn: reborn };
    worker.on("online", function () {
        target.state = "online";
        worker.send({
            event: "online",
            data: [target]
        });
    }).on("exit", function (code, signal) {
        if ((code || signal == "SIGKILL") && keepAlive || code === 826) {
            // If a worker exits accidentally, create a new one.
            createWorker(target, true);
        }
        else {
            target.state = "closed";
            target.emit("exit", code, signal);
            delete ClusterWorkers[id];
        }
    }).on("error", function (err) {
        target.emit("error", err);
    });
}
// Prepare workers.
if (cluster.isMaster) {
    // Handle transmit and broadcast.
    cluster.on("message", function (worker, msg) {
        msg = isNode6 ? msg : worker;
        if (typeof msg == "object") {
            if (msg.event == "----transmit----") {
                msg = msg.data;
                (_a = Worker.to(msg.receivers)).emit.apply(_a, [msg.event].concat(msg.data));
            }
            else if (msg.event == "----broadcast----") {
                msg = msg.data;
                Worker.broadcast.apply(Worker, [msg.event].concat(msg.data));
            }
        }
        var _a;
    });
    Worker.on("online", function (worker) {
        // Handle requests to get workers from a worker.
        worker.on("----get-workers----", function () {
            var workers = filter(values(Workers), function (worker) {
                return worker.isConnected();
            });
            worker.emit("----get-workers----", workers);
        });
    });
}
else {
    // Trigger events when receiving messages.
    process.on("message", function (msg) {
        if (msg && msg.event) {
            (_a = process.emit).call.apply(_a, [process, msg.event].concat(msg.data));
        }
        else if (msg == "----reboot----") {
            process.exit(826);
        }
        var _a;
    });
}
module.exports = Worker;
//# sourceMappingURL=index.js.map