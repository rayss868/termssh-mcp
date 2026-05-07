import { describe, it, expect } from 'vitest';
import { sanitizeCommand } from '../src/core';

describe('maxChars command sanitization', () => {
  it('rejects commands over 1000 characters for the default limit', () => {
    const longCommand = 'echo ' + 'x'.repeat(1000);

    expect(() => sanitizeCommand(longCommand, 1000)).toThrow(
      'Command is too long (max 1000 characters)'
    );
  });

  it('respects a custom positive limit', () => {
    const longCommand = 'echo ' + 'x'.repeat(50);

    expect(() => sanitizeCommand(longCommand, 50)).toThrow(
      'Command is too long (max 50 characters)'
    );
  });

  it('allows unlimited characters when maxChars is Infinity', () => {
    const veryLongCommand = 'echo ' + 'x'.repeat(10000);

    expect(() => sanitizeCommand(veryLongCommand, Infinity)).not.toThrow();
  });

  it('allows unlimited characters when maxChars is non-finite in compatibility mode', () => {
    const veryLongCommand = 'echo ' + 'x'.repeat(10000);

    expect(() => sanitizeCommand(veryLongCommand, Number.POSITIVE_INFINITY)).not.toThrow();
  });

  it('rejects empty commands after trimming', () => {
    expect(() => sanitizeCommand('   ', 1000)).toThrow('Command cannot be empty');
  });

  it('rejects non-string commands', () => {
    expect(() => sanitizeCommand(123 as unknown as string, 1000)).toThrow(
      'Command must be a string'
    );
  });
});
