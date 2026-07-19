/**
 * Issue #305 — the bridge must survive the failures that happen outside the request path.
 *
 * The fault tracker is driven with an explicit clock (never `Date.now()`), and the server handlers
 * are driven against a real `http.Server` by emitting the events Node would emit, so the assertions
 * are about the behaviour a real accept-time failure or malformed request would get.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import {
  attachServerResilience,
  createFaultTracker,
  installProcessResilience,
  FAULT_THRESHOLD,
  FAULT_WINDOW_MS,
} from './resilience.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFaultTracker', () => {
  it('carries on while faults are occasional', () => {
    const tracker = createFaultTracker({ threshold: 3, windowMs: 1000 });
    expect(tracker.record(0)).toBe('continue');
    expect(tracker.record(2000)).toBe('continue');
    expect(tracker.record(4000)).toBe('continue');
  });

  it('gives up once the threshold lands inside the window', () => {
    const tracker = createFaultTracker({ threshold: 3, windowMs: 1000 });
    expect(tracker.record(0)).toBe('continue');
    expect(tracker.record(100)).toBe('continue');
    expect(tracker.record(200)).toBe('exit');
  });

  it('ages faults out of the window rather than counting them forever', () => {
    const tracker = createFaultTracker({ threshold: 3, windowMs: 1000 });
    tracker.record(0);
    tracker.record(100);
    // The first two have aged out by now, so this is the only fault in the window.
    expect(tracker.record(5000)).toBe('continue');
    expect(tracker.record(5100)).toBe('continue');
    expect(tracker.record(5200)).toBe('exit');
  });

  it('defaults to the documented threshold and window', () => {
    const tracker = createFaultTracker();
    for (let i = 0; i < FAULT_THRESHOLD - 1; i += 1) {
      expect(tracker.record(i)).toBe('continue');
    }
    expect(tracker.record(FAULT_THRESHOLD)).toBe('exit');

    const spaced = createFaultTracker();
    for (let i = 0; i < FAULT_THRESHOLD * 2; i += 1) {
      expect(spaced.record(i * FAULT_WINDOW_MS)).toBe('continue');
    }
  });
});

describe('attachServerResilience', () => {
  function withServer(run: (server: Server) => void): void {
    const server = createServer(() => {});
    try {
      run(server);
    } finally {
      server.removeAllListeners();
    }
  }

  it('survives a post-startup server error instead of letting Node re-throw it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    withServer((server) => {
      const onExit = vi.fn();
      attachServerResilience(server, createFaultTracker(), onExit);

      const err: NodeJS.ErrnoException = new Error('accept failed');
      err.code = 'EMFILE';
      // Unhandled, this is exactly what kills the process — `emit('error')` re-throws with no listener.
      expect(() => server.emit('error', err)).not.toThrow();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('accept failed (EMFILE)'));
      expect(onExit).not.toHaveBeenCalled();
    });
  });

  it('exits once server errors arrive faster than the tracker tolerates', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    withServer((server) => {
      const onExit = vi.fn();
      attachServerResilience(server, createFaultTracker({ threshold: 2, windowMs: 60_000 }), onExit);

      server.emit('error', new Error('first'));
      expect(onExit).not.toHaveBeenCalled();
      server.emit('error', new Error('second'));
      expect(onExit).toHaveBeenCalledTimes(1);
    });
  });

  it('answers a malformed request with 400 and closes the connection', () => {
    withServer((server) => {
      attachServerResilience(server, createFaultTracker(), vi.fn());
      const socket = new PassThrough();
      const written: string[] = [];
      socket.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      server.emit('clientError', new Error('parse error'), socket);

      expect(written.join('')).toContain('HTTP/1.1 400 Bad Request');
      expect(written.join('')).toContain('Connection: close');
    });
  });

  it('answers oversized headers with 431', () => {
    withServer((server) => {
      attachServerResilience(server, createFaultTracker(), vi.fn());
      const socket = new PassThrough();
      const written: string[] = [];
      socket.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      const err: NodeJS.ErrnoException = new Error('header overflow');
      err.code = 'HPE_HEADER_OVERFLOW';
      server.emit('clientError', err, socket);

      expect(written.join('')).toContain('431 Request Header Fields Too Large');
    });
  });

  it('destroys the socket rather than writing to a reset connection', () => {
    withServer((server) => {
      attachServerResilience(server, createFaultTracker(), vi.fn());
      const socket = new PassThrough();
      const destroy = vi.spyOn(socket, 'destroy');

      const err: NodeJS.ErrnoException = new Error('reset');
      err.code = 'ECONNRESET';
      server.emit('clientError', err, socket);

      expect(destroy).toHaveBeenCalled();
    });
  });

  it('does not count a malformed request as a fault (a port scan must not restart the bridge)', () => {
    withServer((server) => {
      const onExit = vi.fn();
      attachServerResilience(server, createFaultTracker({ threshold: 2, windowMs: 60_000 }), onExit);

      for (let i = 0; i < 10; i += 1) {
        server.emit('clientError', new Error('parse error'), new PassThrough());
      }
      expect(onExit).not.toHaveBeenCalled();
    });
  });
});

describe('installProcessResilience', () => {
  /**
   * The handlers are invoked directly rather than via `process.emit`: emitting a real
   * `unhandledRejection` inside the test runner would be picked up by the runner's own handler and
   * reported as a failure, which says nothing about this code.
   */
  function installed(onExit: () => void): {
    uncaught: NodeJS.UncaughtExceptionListener;
    rejection: NodeJS.UnhandledRejectionListener;
    cleanup: () => void;
  } {
    const before = {
      uncaught: process.listeners('uncaughtException'),
      rejection: process.listeners('unhandledRejection'),
    };
    installProcessResilience({ tracker: createFaultTracker({ threshold: 2, windowMs: 60_000 }), onExit });
    const uncaught = process
      .listeners('uncaughtException')
      .filter((fn) => !before.uncaught.includes(fn)) as NodeJS.UncaughtExceptionListener[];
    const rejection = process
      .listeners('unhandledRejection')
      .filter((fn) => !before.rejection.includes(fn)) as NodeJS.UnhandledRejectionListener[];
    expect(uncaught).toHaveLength(1);
    expect(rejection).toHaveLength(1);
    return {
      uncaught: uncaught[0]!,
      rejection: rejection[0]!,
      cleanup: () => {
        process.off('uncaughtException', uncaught[0]!);
        process.off('unhandledRejection', rejection[0]!);
      },
    };
  }

  it('logs and survives an uncaught exception, then exits if they keep coming', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onExit = vi.fn();
    const { uncaught, cleanup } = installed(onExit);
    try {
      uncaught(new Error('somewhere in a callback'), 'uncaughtException');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('somewhere in a callback'));
      expect(onExit).not.toHaveBeenCalled();

      uncaught(new Error('again'), 'uncaughtException');
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('logs and survives an unhandled rejection, whatever the reason carries', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onExit = vi.fn();
    const { rejection, cleanup } = installed(onExit);
    try {
      rejection('mqtt publish gave up', Promise.resolve());
      expect(error).toHaveBeenCalledWith(expect.stringContaining('mqtt publish gave up'));
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('shares one fault budget across exception and rejection sources', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onExit = vi.fn();
    const { uncaught, rejection, cleanup } = installed(onExit);
    try {
      uncaught(new Error('one'), 'uncaughtException');
      rejection(new Error('two'), Promise.resolve());
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});

describe('fault handling under a sustained storm', () => {
  it('keeps the fault window bounded rather than growing per fault', () => {
    const tracker = createFaultTracker({ threshold: 3, windowMs: 60_000 });
    // Far more faults than the threshold, all inside one window, with an `onExit` that does not
    // terminate: the verdict must stay `'exit'` without the tracker retaining every timestamp.
    for (let i = 0; i < 1000; i += 1) tracker.record(i);
    expect(tracker.record(1000)).toBe('exit');
    // Once they age out it recovers, proving the retained entries are still real timestamps.
    expect(tracker.record(100_000)).toBe('continue');
  });

  it('calls onExit only once however many faults follow', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createServer(() => {});
    try {
      const onExit = vi.fn();
      const { onExit: latched } = installProcessResilience({
        tracker: createFaultTracker({ threshold: 2, windowMs: 60_000 }),
        onExit,
      });
      const uncaught = process.listeners('uncaughtException').at(-1)!;
      const rejection = process.listeners('unhandledRejection').at(-1)!;
      try {
        attachServerResilience(server, createFaultTracker({ threshold: 2, windowMs: 60_000 }), latched);
        for (let i = 0; i < 5; i += 1) {
          uncaught(new Error(`fault ${i}`), 'uncaughtException');
          server.emit('error', new Error(`server fault ${i}`));
        }
        expect(onExit).toHaveBeenCalledTimes(1);
      } finally {
        process.off('uncaughtException', uncaught as NodeJS.UncaughtExceptionListener);
        process.off('unhandledRejection', rejection as NodeJS.UnhandledRejectionListener);
      }
    } finally {
      server.removeAllListeners();
    }
  });
});
