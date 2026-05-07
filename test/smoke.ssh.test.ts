import { describe, it, expect } from 'vitest';
import { sanitizeCommand } from '../src/index';

describe('termssh smoke', () => {
  it('exports sanitizeCommand for CLI-facing validation', () => {
    expect(sanitizeCommand('echo ok')).toBe('echo ok');
  });
});

describe('maxChars configuration', () => {
  describe('default behavior (1000 chars)', () => {
    it('allows commands under 1000 characters', () => {
      const shortCommand = 'echo hello world';
      expect(() => sanitizeCommand(shortCommand)).not.toThrow();
      expect(sanitizeCommand(shortCommand)).toBe(shortCommand);
    });

    it('rejects commands over 1000 characters', () => {
      const longCommand = 'echo ' + 'x'.repeat(1000);
      expect(() => sanitizeCommand(longCommand)).toThrow('Command is too long (max 1000 characters)');
    });

    it('allows exactly 1000 characters', () => {
      const exactCommand = 'x'.repeat(1000);
      expect(() => sanitizeCommand(exactCommand)).not.toThrow();
      expect(sanitizeCommand(exactCommand)).toBe(exactCommand);
    });
  });

  describe('edge cases', () => {
    it('handles empty command', () => {
      expect(() => sanitizeCommand('')).toThrow('Command cannot be empty');
      expect(() => sanitizeCommand('   ')).toThrow('Command cannot be empty');
    });

    it('handles non-string input', () => {
      expect(() => sanitizeCommand(null as any)).toThrow('Command must be a string');
      expect(() => sanitizeCommand(undefined as any)).toThrow('Command must be a string');
      expect(() => sanitizeCommand(123 as any)).toThrow('Command must be a string');
    });

    it('trims whitespace before checking length', () => {
      const command = 'echo hello';
      const paddedCommand = '   ' + command + '   ';
      expect(sanitizeCommand(paddedCommand)).toBe(command);
    });
  });
});
