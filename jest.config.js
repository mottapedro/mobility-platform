const { pathsToModuleNameMapper } = require('ts-jest');
const path = require('path');

// 1. Buscamos o tsconfig base (o que está na pasta de cima) que realmente tem os paths
const tsconfigJestPath = path.resolve(__dirname, '../tsconfig.jest.json');
const { compilerOptions } = require(tsconfigJestPath);

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/*.spec.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/tests/e2e/"],
  moduleFileExtensions: ["ts", "js"],
  rootDir: ".",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        // Mantém o arquivo local que você já estava usando
        tsconfig: "./tsconfig.jest.json",
      },
    ],
  },
  // 2. Mapeamos os caminhos baseados no arquivo pai, apontando para a raiz correta
  modulePaths: [compilerOptions.baseUrl ? path.resolve(__dirname, '..', compilerOptions.baseUrl) : '<rootDir>'],
  moduleNameMapper: compilerOptions.paths
    ? pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/../' })
    : {},
};
