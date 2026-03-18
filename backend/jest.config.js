/** @type {import('ts-jest').JestConfigWithTsJest} */

const baseConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: false,
    }],
  },
  moduleNameMapper: {
    '^uuid$': '<rootDir>/src/test/__mocks__/uuid.ts',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  forceExit: true,
};

module.exports = {
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/test/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  projects: [
    // Main test suite — excludes CLI tests that spawn child processes
    {
      ...baseConfig,
      displayName: 'main',
      roots: ['<rootDir>/src'],
      testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
      testPathIgnorePatterns: ['<rootDir>/src/cli/__tests__/'],
    },
    // CLI tests — runs in single worker to avoid jest-worker serialization issues
    // (execSync + ts-node child processes cause circular JSON in worker IPC)
    {
      ...baseConfig,
      displayName: 'cli',
      roots: ['<rootDir>/src/cli'],
      testMatch: ['**/__tests__/**/*.ts'],
      maxWorkers: 1,
    },
  ],
};
