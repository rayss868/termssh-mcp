import { describe, it, expect } from 'vitest';
import { InteractiveSessionStore, decodeUploadContent } from '../src/upload';

describe('decodeUploadContent', () => {
  it('decodes utf8 content into a buffer', () => {
    const result = decodeUploadContent('hello world', 'utf8');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString('utf8')).toBe('hello world');
  });

  it('decodes base64 content into a buffer', () => {
    const result = decodeUploadContent('aGVsbG8gd29ybGQ=', 'base64');

    expect(result.toString('utf8')).toBe('hello world');
  });

  it('rejects unsupported content encodings', () => {
    expect(() => decodeUploadContent('hello', 'hex' as any)).toThrow(
      'Unsupported content encoding: hex'
    );
  });
});

describe('InteractiveSessionStore', () => {
  it('creates and reads buffered terminal output incrementally', () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 1024 });
    const session = store.createSession({ cols: 80, rows: 24, platformHint: 'linux' });

    store.appendOutput(session.id, 'hello');
    store.appendOutput(session.id, ' world');

    const firstRead = store.read(session.id);

    expect(firstRead.output).toBe('hello world');
    expect(firstRead.truncated).toBe(false);
    expect(firstRead.closed).toBe(false);
    expect(firstRead.nextSequence).toBeGreaterThan(0);

    const secondRead = store.read(session.id, firstRead.nextSequence);

    expect(secondRead.output).toBe('');
    expect(secondRead.nextSequence).toBe(firstRead.nextSequence);
  });

  it('truncates buffered output when maxBufferedChars is exceeded', () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 5 });
    const session = store.createSession({ cols: 80, rows: 24, platformHint: 'linux' });

    store.appendOutput(session.id, 'hello');
    store.appendOutput(session.id, ' world');

    const read = store.read(session.id);

    expect(read.output).toBe('world');
    expect(read.truncated).toBe(true);
  });

  it('marks sessions as closed and rejects further writes', () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 1024 });
    const session = store.createSession({ cols: 80, rows: 24, platformHint: 'windows' });

    store.appendOutput(session.id, 'before close');
    store.closeSession(session.id, 0);

    const read = store.read(session.id);
    expect(read.closed).toBe(true);
    expect(read.exitCode).toBe(0);

    expect(() => store.appendOutput(session.id, 'after close')).toThrow(
      `Interactive session ${session.id} is already closed`
    );
  });

  it('updates terminal size for an active session', () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 1024 });
    const session = store.createSession({ cols: 80, rows: 24, platformHint: 'linux' });

    store.resizeSession(session.id, 120, 40);

    const updated = store.getSession(session.id);
    expect(updated.cols).toBe(120);
    expect(updated.rows).toBe(40);
  });

  it('uses a stable managed session id prefix when provided', () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 1024 });
    const session = store.createSession({
      cols: 80,
      rows: 24,
      platformHint: 'linux',
      managedSessionPrefix: 'termssh-mcp',
    });

    expect(session.id).toMatch(/^termssh-mcp-[a-z0-9]+$/);
  });

  it('reuses an existing active managed session unless multi-session is explicitly requested', () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 1024 });
    const created = store.createSession({
      cols: 100,
      rows: 30,
      platformHint: 'linux',
      managedSessionPrefix: 'termssh-mcp',
      cwd: '/tmp/project',
      user: 'rayss',
      host: 'example-host',
      stream: {} as any,
    });

    const reused = store.findReusableSession({
      managedSessionPrefix: 'termssh-mcp',
      cwd: '/tmp/project',
      user: 'rayss',
      host: 'example-host',
      allowMultiple: false,
    });

    expect(reused?.id).toBe(created.id);

    const forcedNew = store.findReusableSession({
      managedSessionPrefix: 'termssh-mcp',
      cwd: '/tmp/project',
      user: 'rayss',
      host: 'example-host',
      allowMultiple: true,
    });

    expect(forcedNew).toBeUndefined();
  });

  it('updates heartbeat timestamps when terminal activity occurs', async () => {
    const store = new InteractiveSessionStore({ maxBufferedChars: 1024 });
    const session = store.createSession({
      cols: 80,
      rows: 24,
      platformHint: 'linux',
      managedSessionPrefix: 'termssh-mcp',
    });

    const createdAt = session.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.touchSessionActivity(session.id);
    const afterTouch = store.getSession(session.id).lastActivityAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    store.read(session.id);
    const afterRead = store.getSession(session.id).lastActivityAt;

    expect(afterTouch).toBeGreaterThan(createdAt);
    expect(afterRead).toBeGreaterThanOrEqual(afterTouch);
  });
});
