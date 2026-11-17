import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Checks whether a file exists at the given path.
 */
async function fileExists(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Safely read a text file, returning null if missing or unreadable.
 */
async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detects Node / JS / TS projects.
 */
async function detectNode(projectRoot, fileList) {
  const hasPkgJson = fileList.includes('package.json');
  if (!hasPkgJson) return null;

  const pkgRaw = await safeReadFile(resolve(projectRoot, 'package.json'));
  let pkg = {};
  try {
    pkg = pkgRaw ? JSON.parse(pkgRaw) : {};
  } catch {
    pkg = {};
  }

  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  // Lockfile checks for package manager
  let packageManager = 'npm';
  if (pkg.packageManager) {
    if (pkg.packageManager.startsWith('pnpm')) packageManager = 'pnpm';
    else if (pkg.packageManager.startsWith('yarn')) packageManager = 'yarn';
    else if (pkg.packageManager.startsWith('bun')) packageManager = 'bun';
    else if (pkg.packageManager.startsWith('npm')) packageManager = 'npm';
  } else if (fileList.includes('pnpm-lock.yaml')) {
    packageManager = 'pnpm';
  } else if (fileList.includes('yarn.lock')) {
    packageManager = 'yarn';
  } else if (fileList.includes('bun.lockb') || fileList.includes('bun.lock')) {
    packageManager = 'bun';
  } else if (fileList.includes('package-lock.json')) {
    packageManager = 'npm';
  }

  // TypeScript check
  const isTs = fileList.includes('tsconfig.json') ||
    Boolean(deps.typescript || deps['@types/node'] || Object.keys(deps).some(d => d.startsWith('@types/')));

  // Framework detection
  let framework = null;
  let frameworkLabel = null;
  if (deps.next) {
    framework = 'next';
    frameworkLabel = 'Next.js';
  } else if (deps.nuxt) {
    framework = 'nuxt';
    frameworkLabel = 'Nuxt';
  } else if (deps.vite) {
    framework = 'vite';
    frameworkLabel = 'Vite';
  } else if (deps.svelte || deps['@sveltejs/kit']) {
    framework = 'svelte';
    frameworkLabel = 'SvelteKit';
  } else if (deps.astro) {
    framework = 'astro';
    frameworkLabel = 'Astro';
  } else if (deps.remix || deps['@remix-run/react']) {
    framework = 'remix';
    frameworkLabel = 'Remix';
  } else if (deps['@nestjs/core']) {
    framework = 'nest';
    frameworkLabel = 'NestJS';
  } else if (deps.express) {
    framework = 'express';
    frameworkLabel = 'Express';
  } else if (deps.fastify) {
    framework = 'fastify';
    frameworkLabel = 'Fastify';
  } else if (deps.react) {
    framework = 'react';
    frameworkLabel = 'React';
  } else if (deps.vue) {
    framework = 'vue';
    frameworkLabel = 'Vue';
  }

  // Command resolver helper
  const runPrefix = packageManager === 'npm' ? 'npm run ' : `${packageManager} `;

  let testCommand = null;
  if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
    testCommand = packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
  } else if (deps.vitest) {
    testCommand = `${packageManager === 'npm' ? 'npx' : packageManager} vitest run`;
  } else if (deps.jest) {
    testCommand = `${packageManager === 'npm' ? 'npx' : packageManager} jest`;
  }

  let buildCommand = null;
  if (scripts.build) {
    buildCommand = `${runPrefix}build`;
  }

  let devCommand = null;
  if (scripts.dev) {
    devCommand = `${runPrefix}dev`;
  } else if (scripts.start) {
    devCommand = packageManager === 'npm' ? 'npm start' : `${packageManager} start`;
  }

  return {
    language: isTs ? 'typescript' : 'javascript',
    languageLabel: isTs ? 'TypeScript' : 'JavaScript',
    framework,
    frameworkLabel,
    packageManager,
    packageManagerLabel: packageManager.toUpperCase(),
    buildCommand,
    testCommand,
    devCommand,
    manifestFiles: ['package.json'],
    entryPoints: [pkg.main || (isTs ? 'src/index.ts' : 'index.js')].filter(Boolean),
    details: {
      scripts,
      dependenciesCount: Object.keys(deps).length
    }
  };
}

/**
 * Detects Python projects.
 */
async function detectPython(projectRoot, fileList) {
  const pyManifests = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg', 'manage.py', 'poetry.lock', 'uv.lock'];
  const present = pyManifests.filter(f => fileList.includes(f));
  if (present.length === 0) return null;

  const pyprojectContent = fileList.includes('pyproject.toml')
    ? await safeReadFile(resolve(projectRoot, 'pyproject.toml'))
    : '';
  const reqsContent = fileList.includes('requirements.txt')
    ? await safeReadFile(resolve(projectRoot, 'requirements.txt'))
    : '';

  const combinedMeta = (pyprojectContent || '') + '\n' + (reqsContent || '');

  let packageManager = 'pip';
  if (fileList.includes('uv.lock') || (pyprojectContent && pyprojectContent.includes('[tool.uv]'))) {
    packageManager = 'uv';
  } else if (fileList.includes('poetry.lock') || (pyprojectContent && pyprojectContent.includes('[tool.poetry]'))) {
    packageManager = 'poetry';
  } else if (fileList.includes('Pipfile')) {
    packageManager = 'pipenv';
  } else if (fileList.includes('pdm.lock') || (pyprojectContent && pyprojectContent.includes('[tool.pdm]'))) {
    packageManager = 'pdm';
  }

  let framework = null;
  let frameworkLabel = null;
  const lowerMeta = combinedMeta.toLowerCase();
  if (fileList.includes('manage.py') || lowerMeta.includes('django')) {
    framework = 'django';
    frameworkLabel = 'Django';
  } else if (lowerMeta.includes('fastapi')) {
    framework = 'fastapi';
    frameworkLabel = 'FastAPI';
  } else if (lowerMeta.includes('flask')) {
    framework = 'flask';
    frameworkLabel = 'Flask';
  } else if (lowerMeta.includes('streamlit')) {
    framework = 'streamlit';
    frameworkLabel = 'Streamlit';
  } else if (lowerMeta.includes('torch') || lowerMeta.includes('pytorch')) {
    framework = 'pytorch';
    frameworkLabel = 'PyTorch';
  }

  let testCommand = null;
  if (packageManager === 'poetry') {
    testCommand = 'poetry run pytest';
  } else if (packageManager === 'uv') {
    testCommand = 'uv run pytest';
  } else if (lowerMeta.includes('pytest')) {
    testCommand = 'pytest';
  } else {
    testCommand = 'python -m unittest';
  }

  let buildCommand = null;
  if (packageManager === 'poetry') {
    buildCommand = 'poetry build';
  } else if (packageManager === 'uv') {
    buildCommand = 'uv build';
  } else if (fileList.includes('setup.py') || fileList.includes('pyproject.toml')) {
    buildCommand = 'python -m build';
  }

  let devCommand = null;
  if (framework === 'django') {
    devCommand = 'python manage.py runserver';
  } else if (framework === 'fastapi') {
    devCommand = 'uvicorn main:app --reload';
  } else if (framework === 'flask') {
    devCommand = 'flask run';
  } else if (framework === 'streamlit') {
    devCommand = 'streamlit run app.py';
  }

  return {
    language: 'python',
    languageLabel: 'Python',
    framework,
    frameworkLabel,
    packageManager,
    packageManagerLabel: packageManager,
    buildCommand,
    testCommand,
    devCommand,
    manifestFiles: present,
    entryPoints: ['main.py', 'app.py', 'manage.py'].filter(f => fileList.includes(f)),
    details: {
      manifestCount: present.length
    }
  };
}

/**
 * Detects Rust projects.
 */
async function detectRust(projectRoot, fileList) {
  if (!fileList.includes('Cargo.toml')) return null;

  const cargoRaw = await safeReadFile(resolve(projectRoot, 'Cargo.toml')) || '';
  const lowerCargo = cargoRaw.toLowerCase();

  let framework = null;
  let frameworkLabel = null;
  if (lowerCargo.includes('actix-web')) {
    framework = 'actix-web';
    frameworkLabel = 'Actix Web';
  } else if (lowerCargo.includes('axum')) {
    framework = 'axum';
    frameworkLabel = 'Axum';
  } else if (lowerCargo.includes('rocket')) {
    framework = 'rocket';
    frameworkLabel = 'Rocket';
  } else if (lowerCargo.includes('tauri')) {
    framework = 'tauri';
    frameworkLabel = 'Tauri';
  } else if (lowerCargo.includes('tokio')) {
    framework = 'tokio';
    frameworkLabel = 'Tokio';
  }

  return {
    language: 'rust',
    languageLabel: 'Rust',
    framework,
    frameworkLabel,
    packageManager: 'cargo',
    packageManagerLabel: 'Cargo',
    buildCommand: 'cargo build',
    testCommand: 'cargo test',
    devCommand: 'cargo run',
    manifestFiles: ['Cargo.toml'],
    entryPoints: ['src/main.rs', 'src/lib.rs'].filter(f => fileList.includes(f)),
    details: {}
  };
}

/**
 * Detects Go projects.
 */
async function detectGo(projectRoot, fileList) {
  if (!fileList.includes('go.mod')) return null;

  const goMod = await safeReadFile(resolve(projectRoot, 'go.mod')) || '';
  const lowerMod = goMod.toLowerCase();

  let framework = null;
  let frameworkLabel = null;
  if (lowerMod.includes('github.com/gin-gonic/gin')) {
    framework = 'gin';
    frameworkLabel = 'Gin';
  } else if (lowerMod.includes('github.com/gofiber/fiber')) {
    framework = 'fiber';
    frameworkLabel = 'Fiber';
  } else if (lowerMod.includes('github.com/labstack/echo')) {
    framework = 'echo';
    frameworkLabel = 'Echo';
  }

  return {
    language: 'go',
    languageLabel: 'Go',
    framework,
    frameworkLabel,
    packageManager: 'go',
    packageManagerLabel: 'Go Modules',
    buildCommand: 'go build ./...',
    testCommand: 'go test ./...',
    devCommand: 'go run .',
    manifestFiles: ['go.mod'],
    entryPoints: ['main.go'].filter(f => fileList.includes(f)),
    details: {}
  };
}

/**
 * Detects Java / Kotlin Gradle/Maven projects.
 */
async function detectJvm(projectRoot, fileList) {
  const isMaven = fileList.includes('pom.xml');
  const isGradle = fileList.includes('build.gradle') || fileList.includes('build.gradle.kts');
  if (!isMaven && !isGradle) return null;

  const isKotlin = fileList.includes('build.gradle.kts') || fileList.some(f => f.endsWith('.kt'));

  let framework = null;
  let frameworkLabel = null;
  const pomOrGradle = (await safeReadFile(resolve(projectRoot, isMaven ? 'pom.xml' : (fileList.includes('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle')))) || '';
  if (pomOrGradle.includes('spring-boot')) {
    framework = 'spring-boot';
    frameworkLabel = 'Spring Boot';
  } else if (pomOrGradle.includes('quarkus')) {
    framework = 'quarkus';
    frameworkLabel = 'Quarkus';
  }

  const hasGradlew = fileList.includes('gradlew') || fileList.includes('gradlew.bat');
  const hasMvnw = fileList.includes('mvnw') || fileList.includes('mvnw.cmd');

  let packageManager = isGradle ? 'gradle' : 'maven';
  let buildCommand = isGradle
    ? (hasGradlew ? './gradlew build' : 'gradle build')
    : (hasMvnw ? './mvnw compile' : 'mvn compile');
  let testCommand = isGradle
    ? (hasGradlew ? './gradlew test' : 'gradle test')
    : (hasMvnw ? './mvnw test' : 'mvn test');

  return {
    language: isKotlin ? 'kotlin' : 'java',
    languageLabel: isKotlin ? 'Kotlin' : 'Java',
    framework,
    frameworkLabel,
    packageManager,
    packageManagerLabel: packageManager.toUpperCase(),
    buildCommand,
    testCommand,
    devCommand: null,
    manifestFiles: [isMaven ? 'pom.xml' : (fileList.includes('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle')],
    entryPoints: [],
    details: {}
  };
}

/**
 * Main project auto-detection entry point.
 * Scans `projectRoot` directory and identifies language, framework, package manager, build & test commands.
 *
 * @param {string} projectRoot
 * @returns {Promise<{
 *   detected: boolean,
 *   language: string,
 *   languageLabel: string,
 *   framework: string|null,
 *   frameworkLabel: string|null,
 *   packageManager: string,
 *   packageManagerLabel: string,
 *   buildCommand: string|null,
 *   testCommand: string|null,
 *   devCommand: string|null,
 *   manifestFiles: string[],
 *   entryPoints: string[],
 *   details: object
 * }>}
 */
export async function detectProject(projectRoot) {
  let entries = [];
  try {
    entries = await readdir(projectRoot, { withFileTypes: true });
  } catch (err) {
    return {
      detected: false,
      error: `디렉토리를 읽을 수 없습니다: ${err.message}`,
      language: 'unknown',
      languageLabel: '알 수 없음',
      framework: null,
      frameworkLabel: null,
      packageManager: 'unknown',
      packageManagerLabel: '알 수 없음',
      buildCommand: null,
      testCommand: null,
      devCommand: null,
      manifestFiles: [],
      entryPoints: [],
      details: {}
    };
  }

  const fileList = entries.map(e => e.name);

  // Run detectors in priority order: Node -> Python -> Rust -> Go -> JVM
  const nodeInfo = await detectNode(projectRoot, fileList);
  if (nodeInfo) return { detected: true, ...nodeInfo };

  const pyInfo = await detectPython(projectRoot, fileList);
  if (pyInfo) return { detected: true, ...pyInfo };

  const rustInfo = await detectRust(projectRoot, fileList);
  if (rustInfo) return { detected: true, ...rustInfo };

  const goInfo = await detectGo(projectRoot, fileList);
  if (goInfo) return { detected: true, ...goInfo };

  const jvmInfo = await detectJvm(projectRoot, fileList);
  if (jvmInfo) return { detected: true, ...jvmInfo };

  return {
    detected: false,
    language: 'unknown',
    languageLabel: '알 수 없음',
    framework: null,
    frameworkLabel: null,
    packageManager: 'unknown',
    packageManagerLabel: '알 수 없음',
    buildCommand: null,
    testCommand: null,
    devCommand: null,
    manifestFiles: [],
    entryPoints: [],
    details: {}
  };
}
