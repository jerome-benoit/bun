const EventEmitter = require("node:events");
const { throwNotImplemented } = require("$shared");

declare const self: typeof globalThis;
type WebWorker = InstanceType<typeof globalThis.Worker>;

const { MessageChannel, BroadcastChannel, Worker: WebWorker } = globalThis;
const SHARE_ENV = Symbol("nodejs.worker_threads.SHARE_ENV");

const isMainThread = Bun.isMainThread;
let [_workerData, _threadId, _receiveMessageOnPort] = $lazy("worker_threads");

type NodeWorkerOptions = import("node:worker_threads").WorkerOptions;

const emittedWarnings = new Set<string>();
function emitWarning(type: string, message: string): void {
  if (emittedWarnings.has(type)) return;
  emittedWarnings.add(type);
  // process.emitWarning(message); // our printing is bad
  console.warn("[bun] Warning:", message);
}

function buildFakeEmitter(Class): typeof Class {
  function messageEventHandler(event: MessageEvent) {
    return event.data;
  }

  function errorEventHandler(event: ErrorEvent) {
    return event.error;
  }

  const wrappedListener = Symbol("wrappedListener");

  function wrapped(run: (event) => unknown, listener) {
    const callback = event => {
      return listener(run(event));
    };
    listener[wrappedListener] = callback;
    return callback;
  }

  function functionForEventType(type: string, listener) {
    switch (type) {
      case "error":
      case "messageerror": {
        return wrapped(errorEventHandler, listener);
      }

      default: {
        return wrapped(messageEventHandler, listener);
      }
    }
  }

  Class.prototype.on = function (type: string, listener) {
    this.addEventListener(type, functionForEventType(type, listener));

    return this;
  };

  Class.prototype.off = function (type: string, listener) {
    if (listener) {
      this.removeEventListener(type, listener[wrappedListener] || listener);
    } else {
      this.removeEventListener(type);
    }

    return this;
  };

  Class.prototype.once = function (type: string, listener) {
    this.addEventListener(type, functionForEventType(type, listener), { once: true });

    return this;
  };

  function EventClass(type: string) {
    switch (type) {
      case "error":
      case "messageerror": {
        return ErrorEvent;
      }

      default: {
        return MessageEvent;
      }
    }
  }

  Class.prototype.emit = function (type: string, ...args) {
    this.dispatchEvent(new (EventClass(type))(type, ...args));

    return this;
  };

  Class.prototype.prependListener = Class.prototype.on;
  Class.prototype.prependOnceListener = Class.prototype.once;

  return Class;
}

const MessagePort = buildFakeEmitter(globalThis.MessagePort);

let resourceLimits = {};

let workerData = _workerData;
let threadId = _threadId;
function receiveMessageOnPort(port: MessagePort) {
  let res = _receiveMessageOnPort(port);
  if (!res) return undefined;
  return {
    message: res,
  };
}

function fakeParentPort() {
  const fake = Object.create(MessagePort.prototype);
  Object.defineProperty(fake, "onmessage", {
    get() {
      return self.onmessage;
    },
    set(value) {
      self.onmessage = value;
    },
  });

  Object.defineProperty(fake, "onmessageerror", {
    get() {
      return self.onmessageerror;
    },
    set(value) {
      self.onmessageerror = value;
    },
  });

  Object.defineProperty(fake, "postMessage", {
    value(...args: [any, any]) {
      return self.postMessage(...args);
    },
  });

  Object.defineProperty(fake, "close", {
    value() {},
  });

  Object.defineProperty(fake, "start", {
    value() {},
  });

  Object.defineProperty(fake, "unref", {
    value() {},
  });

  Object.defineProperty(fake, "ref", {
    value() {},
  });

  Object.defineProperty(fake, "hasRef", {
    value() {
      return false;
    },
  });

  Object.defineProperty(fake, "setEncoding", {
    value() {},
  });

  Object.defineProperty(fake, "addEventListener", {
    value: self.addEventListener.bind(self),
  });

  Object.defineProperty(fake, "removeEventListener", {
    value: self.removeEventListener.bind(self),
  });

  return fake;
}
let parentPort: MessagePort | null = isMainThread ? null : fakeParentPort();

function getEnvironmentData() {
  return process.env;
}

function setEnvironmentData(env) {
  process.env = env;
}

function markAsUntransferable() {
  throwNotImplemented("worker_threads.markAsUntransferable");
}

function moveMessagePortToContext() {
  throwNotImplemented("worker_threads.moveMessagePortToContext");
}

const unsupportedOptions = [
  "eval",
  "argv",
  "execArgv",
  "stdin",
  "stdout",
  "stderr",
  "trackedUnmanagedFds",
  "resourceLimits",
];

class Worker extends EventEmitter {
  #worker: WebWorker;
  #performance;

  // this is used by terminate();
  // either is the exit code if exited, a promise resolving to the exit code, or undefined if we haven't sent .terminate() yet
  #onExitPromise: Promise<number> | number | undefined = undefined;

  constructor(filename: string, options: NodeWorkerOptions = {}) {
    super();
    for (const key of unsupportedOptions) {
      if (key in options) {
        emitWarning("option." + key, `worker_threads.Worker option "${key}" is not implemented.`);
      }
    }
    this.#worker = new WebWorker(filename, options);
    this.#worker.addEventListener("close", this.#onClose.bind(this));
    this.#worker.addEventListener("error", this.#onError.bind(this));
    this.#worker.addEventListener("message", this.#onMessage.bind(this));
    this.#worker.addEventListener("messageerror", this.#onMessageError.bind(this));
    this.#worker.addEventListener("open", this.#onOpen.bind(this));
  }

  get threadId() {
    return this.#worker.threadId;
  }

  ref() {
    this.#worker.ref();
  }

  unref() {
    this.#worker.unref();
  }

  get stdin() {
    // TODO:
    return null;
  }

  get stdout() {
    // TODO:
    return null;
  }

  get stderr() {
    // TODO:
    return null;
  }

  get performance() {
    return (this.#performance ??= {
      eventLoopUtilization() {
        emitWarning("performance", "worker_threads.Worker.performance is not implemented.");
        return {
          idle: 0,
          active: 0,
          utilization: 0,
        };
      },
    });
  }

  terminate() {
    const onExitPromise = this.#onExitPromise;
    if (onExitPromise) {
      return $isPromise(onExitPromise) ? onExitPromise : Promise.resolve(onExitPromise);
    }

    const { resolve, promise } = Promise.withResolvers();
    this.#worker.addEventListener(
      "close",
      event => {
        resolve(event.code);
      },
      { once: true },
    );
    this.#worker.terminate();

    return (this.#onExitPromise = promise);
  }

  postMessage(...args: [any, any]) {
    return this.#worker.postMessage(...args);
  }

  #onClose(e: CloseEvent) {
    this.#onExitPromise = e.code;
    this.emit("exit", e.code);
  }

  #onError(error: ErrorEvent) {
    this.emit("error", error);
  }

  #onMessage(event: MessageEvent) {
    // TODO: is this right?
    this.emit("message", event.data);
  }

  #onMessageError(event: MessageEvent) {
    // TODO: is this right?
    this.emit("messageerror", event.data ?? event);
  }

  #onOpen() {
    this.emit("online");
  }

  async getHeapSnapshot() {
    throwNotImplemented("worker_threads.Worker.getHeapSnapshot");
  }
}
export default {
  Worker,
  workerData,
  parentPort,
  resourceLimits,
  isMainThread,
  MessageChannel,
  BroadcastChannel,
  MessagePort,
  getEnvironmentData,
  setEnvironmentData,
  getHeapSnapshot() {
    return {};
  },
  markAsUntransferable,
  moveMessagePortToContext,
  receiveMessageOnPort,
  SHARE_ENV,
  threadId,
};
