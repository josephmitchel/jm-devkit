import { describe, expect, it } from 'vitest';

import { DevkitConfigError } from '../../plugin/devkit-config.mjs';
import { failureSide, NightlyCheckError, projectFault, SetupCommandError } from './failure-side.js';
import { errorType } from './runs.js';

describe('which side a failed run is on, from the type of its error', () => {
  it("is the project's when its project config is invalid", () => {
    expect(failureSide(errorType(new DevkitConfigError('devkit.json is malformed: reviewer is required')))).toBe('project');
  });

  it("is the project's when its setup command failed", () => {
    expect(failureSide(errorType(new SetupCommandError('npm error code E404')))).toBe('project');
  });

  it("is the project's when one of its nightly checks failed", () => {
    const failed = new NightlyCheckError('--- canvas: failed (exit 1)\n3 boards differ\n1 of 2 nightly checks failed: canvas');
    expect(failureSide(errorType(failed))).toBe('project');
    expect(projectFault(errorType(failed))).toBe('one of its nightly checks failed');
    expect(failed.message).toBe('--- canvas: failed (exit 1)\n3 boards differ\n1 of 2 nightly checks failed: canvas');
  });

  it("is the code reviewer's for an error in its own code", () => {
    expect(failureSide(errorType(new TypeError('x is not a function')))).toBe('kit');
    expect(failureSide('Error')).toBe('kit');
  });

  it("is the code reviewer's when the run was killed, exited by itself or never started", () => {
    expect(failureSide('killed by SIGTERM')).toBe('kit');
    expect(failureSide('exit 137')).toBe('kit');
    expect(failureSide('could not start')).toBe('kit');
  });

  it("is the code reviewer's when nothing says what the error was", () => {
    expect(failureSide(null)).toBe('kit');
    expect(failureSide('toString')).toBe('kit');
  });

  it("says what went wrong on the project's side, and nothing for the code reviewer's", () => {
    expect(projectFault('DevkitConfigError')).toBe('its project config (`devkit.json`) is invalid');
    expect(projectFault('SetupCommandError')).toBe('its setup command failed');
    expect(projectFault('TypeError')).toBeNull();
  });

  it('keeps the output of a failed setup command in the message, as before', () => {
    expect(new SetupCommandError('npm error code E404').message).toBe('setup command failed:\nnpm error code E404');
  });
});
