const cluster = require("cluster");
const EventEmitter = require("events");
const ClusterWorkers = {};
const WorkerPids = {};
const Workers = {};
var MaxListeners = 0;

/**
 * A tool for process management and communications. 
 * 
 * When you create a `new Worker`, a new worker process will be forked. You 
 * can keep a worker alive, so when it exits accidentally, a new one will be 
 * forked to replace it.
 * 
 * This module is designed as convenient as it can, many of its methods can be 
 * used both in the master or in a worker process, and you can add event 
 * listeners and emit events both in the master or in the worker process.
 * 
 * This module uses predictable and user-defined IDs to differ workers, so 
 * you can always know which is which.
 */
class Worker extends EventEmitter {
    /**
     * Creates a new worker.
     * 
     * @param {string} id An unique ID of the worker.
     * 
     * @param {boolean} keepAlive If `true`, when the worker process 
     *  accidentally exits, create a new one to replace it immediately. 
     *  default is `false`.
     */
    constructor(id, keepAlive = false) {
        super();

        this.id = id;
        this.keepAlive = keepAlive;
        this.state = "connecting";
        this.receivers = null;
        if (cluster.isMaster && (!Workers[id] || Workers[id] === "closed"))
            createWorker(this);
    }

    /** 
     * Adds a listener function to an event.
     * 
     * @param {string|symbol} event The event name.
     * 
     * @param {(...data?: any[])=>void} listener An event listener function, it 
     *  may accept parameters, which are the data sent by the other end of the
     *  worker, or other workers.
     * 
     * @return {this}
     */
    on(event, listener) {
        if (cluster.isMaster) {
            if (event === "error" || event === "exit") {
                super.on(event, listener);
            } else {
                cluster.on("message", (worker, msg) => {
                    if (msg && msg.id === this.id && msg.event === event) {
                        listener.call(this, ...msg.data);
                    }
                });
            }
        } else {
            process.on(event, listener);
        }
        return this;
    }

    /** 
     * Adds a listener function to an event that will be run only once.
     * 
     * @param {string|symbol} event The event name.
     * 
     * @param {(...data?: any[])=>void} listener An event listener function, it
     *  may accept parameters, which are the data sent by the other end of the
     *  worker, or other workers.
     * 
     * @return {this}
     */
    once(event, listener) {
        if (cluster.isMaster) {
            if (event === "error" || event === "exit") {
                super.once(event, listener);
            } else {
                cluster.once("message", (worker, msg) => {
                    if (msg && msg.id === this.id && msg.event === event) {
                        listener.call(this, ...msg.data);
                    }
                });
            }
        } else {
            process.once(event, listener);
        }
        return this;
    }

    /**
     * Emits an event to the other end of the worker.
     * 
     * @param {string|symbol} event The event name.
     * 
     * @param {any[]} [data] A list of data, they will be received by event 
     *  listeners.
     * 
     * @return {boolean}
     */
    emit(event, ...data) {
        if (event === "online" || event === "error" || event === "exit")
            return false;

        if (cluster.isMaster) {
            if (this.receivers) {
                for (let id of this.receivers) {
                    if (ClusterWorkers[id])
                        ClusterWorkers[id].send({ event, data });
                }
                this.receivers = null;
            } else if (ClusterWorkers[this.id]) {
                ClusterWorkers[this.id].send({ event, data });
            }
        } else {
            if (this.receivers) {
                process.send({
                    id: this.id,
                    event: "----transmit----",
                    data: { receivers: this.receivers, event, data }
                });
            } else {
                process.send({ id: this.id, event, data });
            }
        }
        return true;
    }

    /**
     * Sets receivers that the event will only be emitted to them.
     * 
     * @param {string[]} id The worker id, you can pass several ids at same 
     *  time to set several receivers.
     * 
     * @return {this}
     */
    to(...id) {
        if (id[0] instanceof Array) {
            id = id[0];
        }
        for (let i in id) {
            // If workers are passed, then get their IDs.
            if (id[i] instanceof Worker)
                id[i] = id[i].id;
        }
        this.receivers = id;
        return this;
    }

    /**
     * Emits an event to all workers (the current one included).
     * 
     * @param {string|symbol} event The event name.
     * 
     * @param {any[]} [data] A list of data, they will be received by event 
     *  listeners.
     * 
     * @return {boolean}
     */
    broadcast(event, ...data) {
        if (event === "online" || event === "error" || event === "exit")
            return false;

        if (cluster.isMaster) {
            for (let id in ClusterWorkers) {
                ClusterWorkers[id].send({ event, data });
            }
        } else {
            process.send({
                id: this.id,
                event: "----broadcast----",
                data: { event, data }
            });
        }
        return true;
    }

    /**
     * Gets all workers.
     * 
     * @param {(workers: Worker[])=>void} [cb] If you provide this callback 
     *  function, then it will be called when workers are got, otherwise, the 
     *  method will return a promise. The only parameter that this function 
     *  accepts is the returning workers.
     * 
     * @return {void | Promise<Worker[]>}
     */
    getWorkers(cb = null) {
        if (cluster.isMaster) {
            return this.constructor.getWorkers(cb);
        } else {
            if (cb instanceof Function) {
                this.once("----get-workers----", workers => {
                    for (let i in workers) {
                        if (workers[i].id === this.id) {
                            workers[i] = this;
                        } else {
                            workers[i] = new this.constructor(workers[i].id, workers[i].keepAlive);
                        }
                    }
                    cb(workers);
                }).emit("----get-workers----");
            } else {
                return new Promise(resolve => {
                    this.getWorkers(resolve);
                });
            }
        }
    }

    /** Terminates the current worker. */
    exit() {
        if (cluster.isMaster) {
            ClusterWorkers[this.id].kill();
        } else {
            process.exit();
        }
    }

    /** Restarts the current worker. */
    reboot() {
        if (cluster.isMaster) {
            this.state = "closed";
            ClusterWorkers[this.id].send("----reboot----");
        } else {
            process.exit(826); // 826 indicates reboot code.
        }
    }

    /**
     * @param {number} n
     * @return {this}
     */
    setMaxListeners(n) {
        super.setMaxListeners(n);
        if (cluster.isMaster) {
            var max = MaxListeners;
            for (let i in Workers) {
                max += Workers[i].getMaxListeners();
            }
            cluster.setMaxListeners(max);
        } else {
            process.setMaxListeners(n);
        }
        return this;
    }

    /** Whether the process is the master. */
    static get isMaster() {
        return cluster.isMaster;
    }

    /** Whether the process is a worker. */
    static get isWorker() {
        return cluster.isWorker;
    }

    static get Worker() {
        return this;
    }

    /** 
     * Adds a listener function to an event, which only accepts `online` and 
     * `exit`. All worker actions should be put in the callback function which
     * pass the worker parameter.
     * 
     * @param {"online" | "exit"} event The event name.
     * 
     * @param {(worker: Worker)=>void} listener An event listener function, it 
     *  accepts only one parameter, which is the worker.
     * 
     * @return {typeof Worker}
     */
    static on(event, listener) {
        if (cluster.isMaster) {
            if (event === "online") {
                MaxListeners += 1;
                cluster.setMaxListeners(cluster.getMaxListeners() + 1);
                cluster.on("online", worker => {
                    var { id, keepAlive, reborn } = WorkerPids[worker.process.pid];
                    if (!reborn) {
                        // Reborn workers do not emit this event.
                        listener(Workers[id]);
                    }
                });
            } else if (event === "exit") {
                MaxListeners += 1;
                cluster.setMaxListeners(cluster.getMaxListeners() + 1);
                cluster.on("exit", (worker, code, signal) => {
                    var { id, keepAlive } = WorkerPids[worker.process.pid];
                    // Keep-alive workers only emit this event once.
                    if (!code || (code && !keepAlive)) {
                        listener(Workers[id], code, signal);
                    }
                });
            }
        } else {
            if (event === "online") {
                process.on("message", msg => {
                    if (msg && msg.event === event) {
                        var { id, keepAlive } = msg.data[0];
                        if (!Workers[id]) {
                            // Initiate worker instance.
                            Workers[id] = new this(id, keepAlive);
                            WorkerPids[process.pid] = { id, keepAlive };
                            Workers[id].state = "online";

                            // Emit event for Worker.getWorker().
                            process.emit("----online----", id);
                        }
                        listener(Workers[id]);
                    }
                });
            } else if (event === "exit") {
                process.on("exit", (code, signal) => {
                    var { id, keepAlive } = WorkerPids[process.pid];
                    // Keep-alive workers only emit this event once.
                    if (!code || (code && !keepAlive)) {
                        listener(Workers[id], code, signal);
                    }
                });
            }
        }
        return this;
    }

    /**
     * Emits an event to some worker process(es), if you don't call 
     * `Worker.to()` before calling this method, then it will act the same 
     * as broadcast.
     * 
     * @param {string|symbol} event The event name.
     * 
     * @param {any[]} [data] A list of data, they will be received by event 
     *  listeners.
     */
    static emit(event, ...data) {
        if (event === "online" || event === "error" || event === "exit")
            return false;

        if (cluster.isMaster) {
            if (!this.receivers) {
                return this.broadcast(event, ...data);
            } else {
                for (let id of this.receivers) {
                    if (ClusterWorkers[id])
                        ClusterWorkers[id].send({ event, data });
                }
                this.receivers = null;
            }
        } else {
            throw new ReferenceError(`Cannot call static method '${this.name}.emit()' in a worker process.`);
        }
        return true;
    }

    /**
     * Sets receivers that the event will only be emitted to them.
     * 
     * @param {string[]} id The worker id, you can pass several ids at same 
     *  time to set several receivers.
     * 
     * @return {typeof Worker}
     */
    static to(...id) {
        if (cluster.isMaster) {
            if (id[0] instanceof Array) {
                id = id[0];
            }
            for (let i in id) {
                // If workers are passed, then get their IDs.
                if (id[i] instanceof Worker)
                    id[i] = id[i].id;
            }
            this.receivers = id;
        } else {
            throw new ReferenceError(`Cannot call static method '${this.name}.to()' in a worker process.`);
        }
        return this;
    }

    /**
     * Emits an event to all workers (worker processes).
     * 
     * @param {string|symbol} event The event name.
     * 
     * @param {any[]} [data] A list of data, they will be received by event 
     *  listeners.
     */
    static broadcast(event, ...data) {
        if (event === "online" || event === "error" || event === "exit")
            return false;

        if (cluster.isMaster) {
            for (let id in ClusterWorkers) {
                ClusterWorkers[id].send({ event, data });
            }
        } else {
            throw new ReferenceError(`Cannot call static method '${this.name}.broadcast()' in a worker process.`);
        }
        return true;
    }

    /**
     * Gets all workers.
     * 
     * @param {(workers: Worker[])=>void} [cb] If you provide this callback 
     *  function, then it will be called when workers are got, otherwise, the 
     *  method will return a promise. The only parameter that this function 
     *  accepts is the returning workers.
     * 
     * @return {void | Promise<Worker[]>}
     */
    static getWorkers(cb = null) {
        if (cb instanceof Function) {
            if (this.isMaster) {
                cb(getValues(Workers));
            } else {
                throw new ReferenceError(`Cannot call static method '${this.name}.getWorkers()' in a worker process.`);
            }
        } else {
            return new Promise(resolve => {
                this.getWorkers(resolve);
            });
        }
    }

    /** 
     * Gets the current worker.
     * 
     * @param {(worker: Worker)=>void} [cb] If you provide this callback 
     *  function, then it will be called when the worker is got, otherwise, 
     *  the method will return a promise. The only parameter that this 
     *  function accepts is the returning worker.
     * 
     * @return {void | Promise<Worker>}
     */
    static getWorker(cb = null) {
        if (this.isMaster) {
            throw new Error(`Cannot call static method '${this.name}.getChannel()' in the master process.`);
        }
        if (cb instanceof Function) {
            var worker = getValues(Workers)[0];
            if (worker) {
                cb(worker);
            } else {
                process.once("----online----", id => {
                    cb(Workers[id]);
                });
            }
        } else {
            return new Promise(resolve => {
                this.getChannel(resolve);
            });
        }
    }
}

function getValues(obj) {
    if (Object.values instanceof Function) {
        return Object.values(obj);
    } else {
        var values = [];
        for (let i in obj) {
            values.push(obj[i]);
        }
        return values;
    }
}

/** Creates worker process. */
function createWorker(target, reborn = false) {
    var { id, keepAlive } = target,
        worker = cluster.fork();

    Workers[id] = target;
    ClusterWorkers[id] = worker;
    WorkerPids[worker.process.pid] = { id, keepAlive, reborn };

    worker.on("online", () => {
        target.state = "online";
        worker.send({
            event: "online",
            data: [target]
        });
    }).on("exit", (code, signal) => {
        if ((code || signal == "SIGKILL") && keepAlive || code === 826) {
            // If a worker exits accidentally, create a new one.
            createWorker(target, true);
        } else {
            target.state = "closed";
            target.emit("exit", code, signal);
            delete Workers[id];
            delete ClusterWorkers[id];
        }
    }).on("error", err => {
        target.emit("error", err);
    });
}

// Prepare workers.
if (cluster.isMaster) {
    // Handle transmit and broadcast.
    cluster.on("message", (worker, msg) => {
        if (msg && msg.event == "----transmit----") {
            msg = msg.data;
            Worker.to(msg.receivers).emit(msg.event, ...msg.data);
        } else if (msg && msg.event == "----broadcast----") {
            msg = msg.data;
            Worker.broadcast(msg.event, ...msg.data);
        }
    });

    Worker.on("online", worker => {
        // Handle requests to get workers from a worker.
        worker.on("----get-workers----", () => {
            worker.emit("----get-workers----", getValues(Workers));
        });
    });
} else {
    // Trigger events when receiving messages.
    process.on("message", (msg) => {
        if (msg && msg.event) {
            process.emit(msg.event, ...msg.data);
        } else if (msg === "----reboot----") {
            process.exit(826);
        }
    });
}

module.exports = Worker;