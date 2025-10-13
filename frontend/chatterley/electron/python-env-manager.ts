/**
 * Python Environment Manager - handles setup and management of standalone Python environments
 * for Chatterley without requiring conda installation
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import log from 'electron-log';
import { SystemDetector, SystemInfo } from './system-detector';

type WindowsWheelProfile = 'cpu' | 'cuda12.6';
type LlamaWheelProfile = WindowsWheelProfile | 'mac';

const LLAMA_WHEEL_RESOURCES: Record<LlamaWheelProfile, { relativePath: string }> = {
  mac: { relativePath: path.join('python-wheels', 'mac', 'llama_cpp_python-0.3.16-cp312-cp312-macosx_15_0_arm64.whl') },
  cpu: { relativePath: path.join('python-wheels', 'cpu', 'llama_cpp_python-0.3.16-cp312-cp312-win_amd64_cpu.whl') },
  'cuda12.6': { relativePath: path.join('python-wheels', 'cuda12.6', 'llama_cpp_python-0.3.16-cp312-cp312-win_amd64_cu126.whl') },
};

export interface SetupProgress {
  step: string;
  progress: number;      // 0-100
  message: string;
  isComplete: boolean;
  estimatedTimeRemaining?: string;
}

export interface EnvironmentInfo {
  path: string;
  pythonPath: string;
  isValid: boolean;
  createdAt?: string;
  lastUsed?: string;
  systemInfo?: SystemInfo;
}

export class PythonEnvironmentManager {
  private progressCallback?: (progress: SetupProgress) => void;
  private isSettingUp: boolean = false;
  private setupProcess: ChildProcess | null = null;
  private cachedSystemInfo?: SystemInfo;
  
  constructor() {
    // Initialize logging
    log.info('[PythonEnvManager] Initialized');
  }

  private extraPathDirs: string[] = [];

  private addExtraPath(dir: string): void {
    if (!dir) return;
    if (!this.extraPathDirs.includes(dir)) {
      this.extraPathDirs.push(dir);
    }
  }

  private getWindowsWheelProfile(): WindowsWheelProfile {
    const requested = (process.env.LLAMA_WHEEL_PROFILE || '').trim().toLowerCase();
    if (requested === 'cuda12.6') {
      log.info('[PythonEnvManager] Using wheel profile from environment: cuda12.6');
      return 'cuda12.6';
    }
    if (requested === 'cpu') {
      log.info('[PythonEnvManager] Using wheel profile from environment: cpu');
      return 'cpu';
    }
    if (requested === 'cuda12.4') {
      log.warn('[PythonEnvManager] Wheel profile cuda12.4 is no longer supported; defaulting to cpu');
      return 'cpu';
    }
    if (requested.length > 0) {
      log.warn('[PythonEnvManager] Unknown wheel profile "%s"; falling back to auto-detection', requested);
    }

    const shouldUseCudaProfile =
      process.platform === 'win32' &&
      this.cachedSystemInfo?.cudaAvailable &&
      (this.cachedSystemInfo.cudaDevices?.length ?? 0) > 0;

    if (shouldUseCudaProfile) {
      log.info('[PythonEnvManager] Wheel profile not set; detected CUDA-capable Windows system. Using cuda12.6 profile.');
      return 'cuda12.6';
    }

    log.info('[PythonEnvManager] Wheel profile not set; defaulting to cpu');
    return 'cpu';
  }

  private configureWindowsCudaRuntime(profile: WindowsWheelProfile): void {
    if (process.platform !== 'win32') {
      return;
    }

    if (profile !== 'cuda12.6') {
      return;
    }

    const runnerBinRelative = path.join('windows-runners', 'cuda_v12.6', 'bin');
    const runnerBin = this.resolveResourcePath(runnerBinRelative);
    if (!fs.existsSync(runnerBin)) {
      log.warn('[PythonEnvManager] CUDA runner bin directory not found at %s', runnerBin);
      return;
    }

    this.addExtraPath(runnerBin);

    const currentPath = process.env.PATH || process.env.Path || '';
    const normalisedRunnerBin = path.normalize(runnerBin).toLowerCase();
    const pathEntries = currentPath
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => path.normalize(entry).toLowerCase());
    if (!pathEntries.includes(normalisedRunnerBin)) {
      const delimiter = path.delimiter;
      process.env.PATH = currentPath ? `${runnerBin}${delimiter}${currentPath}` : runnerBin;
      process.env.Path = process.env.PATH;
    }

    const runnerRoot = path.resolve(runnerBin, '..');
    const ensureEnv = (key: string) => {
      if (!process.env[key]) {
        process.env[key] = runnerRoot;
      }
    };

    ensureEnv('CUDA_PATH');
    ensureEnv('CUDA_PATH_V12_6');
    ensureEnv('CUDA_HOME');
    if (!process.env.CUDA_VERSION) {
      process.env.CUDA_VERSION = '12.6';
    }

    log.info('[PythonEnvManager] Configured CUDA runtime paths using bundled runners at %s', runnerBin);
  }

  private prepareWindowsWheelForInstallation(originalPath: string): string {
    if (process.platform !== 'win32') {
      return originalPath;
    }

    const basename = path.basename(originalPath);
    const needsSanitization = /win_amd64_[^\\]+\.whl$/i.test(basename);

    if (!needsSanitization) {
      return originalPath;
    }

    const sanitizedBasename = basename.replace(/win_amd64_[^-.]+/i, 'win_amd64');
    if (sanitizedBasename === basename) {
      return originalPath;
    }

    const cacheDir = path.join(os.tmpdir(), 'chatterley-wheel-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const sanitizedPath = path.join(cacheDir, sanitizedBasename);

    if (!fs.existsSync(sanitizedPath)) {
      try {
        fs.copyFileSync(originalPath, sanitizedPath);
        log.info(
          '[PythonEnvManager] Copied wheel to sanitized path for installation: %s -> %s',
          originalPath,
          sanitizedPath
        );
      } catch (error) {
        log.warn(
          '[PythonEnvManager] Failed to copy wheel to sanitized path (%s); installing original path instead: %s',
          sanitizedPath,
          error
        );
        return originalPath;
      }
    } else {
      log.info(
        '[PythonEnvManager] Using cached sanitized wheel for installation: %s',
        sanitizedPath
      );
    }

    return sanitizedPath;
  }

  private getWindowsTorchSpec(profile: WindowsWheelProfile): {
    packages: string[];
    indexUrl?: string;
    torchVersion?: string;
    cudaVersion?: string;
  } | null {
    const specs: Partial<Record<WindowsWheelProfile, { packages: string[]; indexUrl: string; torchVersion: string; cudaVersion: string; }>> = {
      'cuda12.6': {
        packages: [
          'torch==2.7.1+cu126',
          'torchaudio==2.7.1+cu126',
          'torchvision==0.22.1+cu126',
        ],
        indexUrl: 'https://download.pytorch.org/whl/cu126',
        torchVersion: '2.7.1',
        cudaVersion: '12.6',
      },
    };

    const spec = specs[profile];
    return spec ?? null;
  }

  private async installWindowsTorchRuntime(
    envPath: string,
    uvPath: string,
    pythonPath: string
  ): Promise<void> {
    if (process.platform !== 'win32') {
      return;
    }

    const profile = this.getWindowsWheelProfile();
    const spec = this.getWindowsTorchSpec(profile);
    this.configureWindowsCudaRuntime(profile);
    if (!spec) {
      return;
    }

    let needsInstall = true;
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        let out = '';
        let err = '';
        const child = spawn(pythonPath, ['-c', 'import json, torch\nprint(json.dumps({"version": torch.__version__, "cuda": getattr(torch.version, "cuda", None)}))'], {
          env: this.buildVirtualEnvProcessEnv(envPath),
          stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout?.on('data', (data) => { out += data.toString(); });
        child.stderr?.on('data', (data) => { err += data.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolve(out);
          } else {
            reject(new Error(err));
          }
        });
      });
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const payload = JSON.parse(lines.pop() ?? '{}');
      if (payload.version && typeof payload.version === 'string') {
        const versionMatches = spec.torchVersion ? payload.version.startsWith(spec.torchVersion) : true;
        const cudaMatches = spec.cudaVersion ? ((payload.cuda ?? '') as string).startsWith(spec.cudaVersion) : true;
        if (versionMatches && cudaMatches) {
          needsInstall = false;
        }
      }
    } catch (error) {
      log.debug('[PythonEnvManager] Torch inspection failed, reinstalling runtime:', error);
    }

    if (!needsInstall) {
      log.info('[PythonEnvManager] Torch runtime already matches profile %s', profile);
      return;
    }

    const description = `Installing Torch runtime (${profile})`;
    await this.reportProgress('torch', 60, `${description}...`);

    const args = ['pip', 'install', '--upgrade'];
    args.push(...spec.packages);
    if (spec.indexUrl) {
      args.push('--index-url', spec.indexUrl);
    }

    log.info('[PythonEnvManager] Installing Torch with args: %s', args.join(' '));
    await this.runUvCommand(uvPath, envPath, args, description);
  }

  private applyWindowsBackendDefaults(result: { sglang: boolean; vllm: boolean; llamacpp: boolean }): { sglang: boolean; vllm: boolean; llamacpp: boolean } {
    if (process.platform !== 'win32') {
      return result;
    }
    const profile = this.getWindowsWheelProfile();
    if (profile === 'cuda12.6') {
      log.info('[PythonEnvManager] vLLM support disabled on Windows; forcing llamacpp-only configuration');
      return {
        sglang: result.sglang,
        vllm: false,
        llamacpp: true
      };
    }
    if (profile === 'cpu') {
      return {
        sglang: result.sglang,
        vllm: false,
        llamacpp: true
      };
    }
    return result;
  }

  /**
   * Resolve the bin/Scripts directory for a given virtual environment
   */
  private getVirtualEnvBinDir(envPath: string): string {
    return process.platform === 'win32'
      ? path.join(envPath, 'Scripts')
      : path.join(envPath, 'bin');
  }

  /**
   * Build a process environment with the virtualenv PATH/VIRTUAL_ENV populated
   */
  private buildVirtualEnvProcessEnv(envPath: string): NodeJS.ProcessEnv {
    const binDir = this.getVirtualEnvBinDir(envPath);
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const currentPath = process.env.PATH || process.env.Path || '';

    const pathEntries: string[] = [];
    const seen = new Set<string>();

    const pushEntry = (entry: string | null | undefined) => {
      if (!entry) return;
      const normalized = process.platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      pathEntries.push(entry);
    };

    pushEntry(binDir);
    for (const extra of this.extraPathDirs) {
      pushEntry(extra);
    }
    pushEntry(currentPath);

    const combinedPath = pathEntries.join(delimiter);

    return {
      ...process.env,
      VIRTUAL_ENV: envPath,
      PATH: combinedPath,
      Path: combinedPath, // Some Windows environments read capitalized variant
      GGML_CCACHE: 'OFF',
    };
  }

  /**
   * Run a uv command within the virtual environment with basic logging
   */
  private async runUvCommand(
    uvPath: string,
    envPath: string,
    args: string[],
    description: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      log.info(`[PythonEnvManager] ${description} (uv ${args.join(' ')})`);
      const proc = spawn(uvPath, args, {
        stdio: 'pipe',
        env: this.buildVirtualEnvProcessEnv(envPath),
      });

      this.setupProcess = proc;
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          log.info(`[PythonEnvManager] uv stdout: ${text}`);
        }
      });

      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        const trimmed = text.trim();
        if (trimmed) {
          log.warn(`[PythonEnvManager] uv stderr: ${trimmed}`);
        }
      });

      proc.on('close', (code) => {
        this.setupProcess = null;
        if (code === 0) {
          resolve();
        } else {
          const message = `${description} failed with exit code ${code}`;
          log.error(`[PythonEnvManager] ${message}`);
          log.error(`[PythonEnvManager] uv stderr: ${stderr}`);
          reject(new Error(`${message}: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        this.setupProcess = null;
        log.error('[PythonEnvManager] uv command error:', error);
        reject(error);
      });
    });
  }

  /**
   * Check whether a command is available (returns true if it executes successfully)
   */
  private async checkCommandAvailability(
    command: string,
    args: string[] = ['--version'],
    envPath?: string
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(command, args, {
          stdio: 'ignore',
          env: envPath ? this.buildVirtualEnvProcessEnv(envPath) : process.env,
        });

        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
      } catch (error) {
        resolve(false);
      }
    });
  }

  /**
   * Determine if cmake is accessible within the virtual environment
   */
  private async hasCMake(envPath: string): Promise<boolean> {
    if (await this.checkCommandAvailability('cmake', ['--version'], envPath)) {
      return true;
    }

    const binDir = this.getVirtualEnvBinDir(envPath);
    const cmakeExecutable =
      process.platform === 'win32'
        ? path.join(binDir, 'cmake.exe')
        : path.join(binDir, 'cmake');

    if (fs.existsSync(cmakeExecutable)) {
      return this.checkCommandAvailability(cmakeExecutable, ['--version'], envPath);
    }

    return false;
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true }).catch(() => {});
    return new Promise((resolve, reject) => {
      const downloadRecursive = (currentUrl: string, redirectCount: number = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects while downloading.'));
          return;
        }

        const parsed = new URL(currentUrl);
        const client = parsed.protocol === 'https:' ? https : http;

        const request = client.get(parsed, (response) => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            const nextUrl = new URL(response.headers.location, currentUrl).toString();
            downloadRecursive(nextUrl, redirectCount + 1);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download ${currentUrl}: HTTP ${response.statusCode}`));
            return;
          }

          const file = fs.createWriteStream(destination);
          response.pipe(file);
          file.on('finish', () => {
            file.close(() => resolve());
          });
          file.on('error', (error) => {
            fs.unlink(destination, () => reject(error));
          });
        });

        request.on('error', (error) => {
          reject(error);
        });
      };

      downloadRecursive(url);
    });
  }

  private async expandZipWindows(zipPath: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const escapedZip = zipPath.replace(/'/g, "''");
      const escapedDest = destination.replace(/'/g, "''");
      const script = `Expand-Archive -Path '${escapedZip}' -DestinationPath '${escapedDest}' -Force`;
      const proc = spawn('powershell', ['-NoLogo', '-NonInteractive', '-Command', script], {
        stdio: 'pipe',
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Expand-Archive failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Ensure Windows build prerequisites (CMake) are present when installing llama.cpp extras
   */
  private async ensureWindowsBuildDependencies(
    envPath: string,
    uvPath: string,
    extras: string[]
  ): Promise<void> {
    if (process.platform !== 'win32') {
      return;
    }

    if (!extras.includes('llama_cpp')) {
      return;
    }

    if (process.env.CH_FORCE_LLAMA_BUILD !== '1') {
      log.info('[PythonEnvManager] Skipping Windows build dependency checks; prebuilt llama.cpp wheels will be used.');
      return;
    }

    if (await this.hasCMake(envPath)) {
      log.info('[PythonEnvManager] Detected CMake in PATH for llama.cpp build');
      return;
    }

    await this.reportProgress(
      'build_tools',
      68,
      'Installing CMake toolchain (required for llama.cpp)...'
    );

    try {
      await this.runUvCommand(
        uvPath,
        envPath,
        ['pip', 'install', 'cmake', 'ninja'],
        'Installing build tool prerequisites'
      );
    } catch (error) {
      log.warn(
        '[PythonEnvManager] Automatic CMake installation via pip failed:',
        error
      );
    }

    if (await this.hasCMake(envPath)) {
      log.info('[PythonEnvManager] CMake available after auto-installation');
      return;
    }

    const message =
      'CMake is required to install llama.cpp on Windows. Install the Microsoft C++ Build Tools (with the CMake component) or add CMake to PATH, then restart Chatterley.';
    log.error(`[PythonEnvManager] ${message}`);
    throw new Error(message);
  }

  private async ensureGitAvailable(envPath: string): Promise<void> {
    if (await this.checkCommandAvailability('git', ['--version'], envPath)) {
      log.info('[PythonEnvManager] Git command already available');
      return;
    }

    if (process.platform !== 'win32') {
      throw new Error('Git is required but was not found. Please install Git and restart Chatterley.');
    }

    const toolsDir = path.join(this.getUserDataDir(), 'tools');
    const gitRoot = path.join(toolsDir, 'mingit');
    const gitCmdDir = path.join(gitRoot, 'cmd');
    const gitExe = path.join(gitCmdDir, 'git.exe');

    const resourcesRoot = app.isPackaged
      ? process.resourcesPath
      : path.resolve(__dirname, '../..');
    const packagedCandidates = [
      path.join(resourcesRoot, 'windows-tools', 'mingit'),
      path.join(resourcesRoot, 'windows-tools', 'MinGit-2.46.0-64-bit'),
      path.join(resourcesRoot, 'windows-tools')
    ];

    for (const candidateRoot of packagedCandidates) {
      if (!candidateRoot || !fs.existsSync(candidateRoot)) {
        continue;
      }

      const candidatePaths = fs.statSync(candidateRoot).isDirectory()
        ? fs.readdirSync(candidateRoot).map((name) => path.join(candidateRoot, name))
        : [];

      const allCandidates = [candidateRoot, ...candidatePaths];
      for (const candidate of allCandidates) {
        const cmdPath = path.join(candidate, 'cmd', 'git.exe');
        if (fs.existsSync(cmdPath)) {
          log.info('[PythonEnvManager] Found packaged MinGit at %s', candidate);
          await fs.promises.rm(gitRoot, { recursive: true, force: true });
          await fs.promises.mkdir(path.dirname(gitRoot), { recursive: true });
          await fs.promises.cp(candidate, gitRoot, { recursive: true });
          break;
        }
      }
      if (fs.existsSync(gitExe)) {
        break;
      }
    }

    if (!fs.existsSync(gitExe)) {
      const version = '2.46.0';
      const release = `v${version}.windows.1`;
      const url = `https://github.com/git-for-windows/git/releases/download/${release}/MinGit-${version}-64-bit.zip`;
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mingit-'));
      const zipPath = path.join(tempDir, 'mingit.zip');

      try {
        log.info('[PythonEnvManager] Downloading portable Git for Windows...', { url });
        await this.downloadFile(url, zipPath);

        const extractDir = path.join(tempDir, 'extract');
        await fs.promises.mkdir(extractDir, { recursive: true });
        await this.expandZipWindows(zipPath, extractDir);

        const entries = await fs.promises.readdir(extractDir);
        const sourceRoot = entries
          .map((entry) => path.join(extractDir, entry))
          .find((candidate) => fs.existsSync(path.join(candidate, 'cmd', 'git.exe')));

        if (!sourceRoot) {
          throw new Error('Downloaded MinGit archive did not contain expected structure.');
        }

        await fs.promises.rm(gitRoot, { recursive: true, force: true });
        await fs.promises.mkdir(path.dirname(gitRoot), { recursive: true });
        await fs.promises.cp(sourceRoot, gitRoot, { recursive: true });
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (!fs.existsSync(gitExe)) {
      throw new Error('Failed to provision portable Git. Please install Git for Windows manually.');
    }

    this.addExtraPath(gitCmdDir);
    process.env.PATH = `${gitCmdDir};${process.env.PATH ?? ''}`;
    process.env.Path = process.env.PATH;

    if (!(await this.checkCommandAvailability('git', ['--version'], envPath))) {
      throw new Error('Git is still unavailable after installing portable Git.');
    }

    log.info('[PythonEnvManager] Portable Git configured successfully.');
  }

  private getResourcesRoots(): string[] {
    if (!app.isPackaged) {
      const devRoot = path.resolve(__dirname, '../..');
      log.info('[PythonEnvManager] Resources root (dev): %s', devRoot);
      return [devRoot];
    }

    const primary = process.resourcesPath;
    const roots = [
      primary,
      path.join(primary, 'app.asar.unpacked'),
      path.join(primary, '..', 'app.asar.unpacked'),
    ];

    log.info('[PythonEnvManager] Resources roots (packaged): %s', roots.join(' | '));
    return roots;
  }

  private resolveResourcePath(relativePath: string): string {
    log.info('[PythonEnvManager] Resolving resource: %s', relativePath);
    for (const root of this.getResourcesRoots()) {
      const candidate = path.join(root, relativePath);
      if (fs.existsSync(candidate)) {
        log.info('[PythonEnvManager] Found resource at %s', candidate);
        return candidate;
      }
      log.info('[PythonEnvManager] Resource not found at %s', candidate);
    }

    return path.join(this.getResourcesRoots()[0], relativePath);
  }

  private resolveLlamaWheel(profile: LlamaWheelProfile, pythonTag?: string): string | null {
    const entry = LLAMA_WHEEL_RESOURCES[profile];
    if (!entry) {
      return null;
    }

    const absolutePath = this.resolveResourcePath(entry.relativePath);
    if (!fs.existsSync(absolutePath)) {
      log.warn('[PythonEnvManager] Expected llama-cpp wheel missing at %s', absolutePath);
      return null;
    }

    if (pythonTag && !path.basename(absolutePath).includes(pythonTag)) {
      log.warn('[PythonEnvManager] Llama wheel %s does not match required Python tag %s', path.basename(absolutePath), pythonTag);
      return null;
    }

    log.info('[PythonEnvManager] Selected llama-cpp wheel: %s', absolutePath);
    return absolutePath;
  }

  /**
   * Determine the Python major.minor tag (e.g., cp312) for the given interpreter
   */
  private async getPythonTag(pythonPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(pythonPath, ['-c', 'import sys; print(f"cp{sys.version_info[0]}{sys.version_info[1]:02d}")'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });

        let output = '';
        proc.stdout?.on('data', (data) => {
          output += data.toString();
        });

        proc.on('error', () => resolve(null));
        proc.on('close', (code) => {
          if (code === 0) {
            resolve(output.trim());
          } else {
            resolve(null);
          }
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  /**
   * Pre-install the bundled llama-cpp wheel so uv/pip does not try to build from source
   */
  private async installPrebuiltGpuWheels(
    envPath: string,
    uvPath: string,
    extras: string[],
    pythonPath: string
  ): Promise<void> {
    const wheelEntries: Array<{ label: string; path: string; progressStep: string; progressValue: number }> = [];
    const pythonTag = await this.getPythonTag(pythonPath);

    if (process.platform === 'win32') {
      const profile = this.getWindowsWheelProfile();

      if (extras.includes('llama_cpp')) {
        log.info('[PythonEnvManager] Attempting bundled llama-cpp install (profile=%s, pythonTag=%s)', profile, pythonTag || 'unknown');
        const llamaWheel = this.resolveLlamaWheel(profile, pythonTag || undefined);
        if (llamaWheel) {
          const installPath = this.prepareWindowsWheelForInstallation(llamaWheel);
          wheelEntries.push({
            label: 'llama.cpp',
            path: installPath,
            progressStep: 'build_tools',
            progressValue: 69,
          });
        } else {
          log.info('[PythonEnvManager] No prebuilt llama-cpp wheel available, continuing without it');
        }
      }
    } else if (process.platform === 'darwin' && process.arch === 'arm64') {
      if (extras.includes('llama_cpp')) {
        log.info('[PythonEnvManager] Attempting bundled llama-cpp install for macOS (pythonTag=%s)', pythonTag || 'unknown');
        const llamaWheel = this.resolveLlamaWheel('mac', pythonTag || undefined);
        if (llamaWheel) {
          wheelEntries.push({
            label: 'llama.cpp',
            path: llamaWheel,
            progressStep: 'build_tools',
            progressValue: 69,
          });
        } else {
          log.info('[PythonEnvManager] No prebuilt llama-cpp wheel available for macOS, continuing without it');
        }
      } else {
        log.info('[PythonEnvManager] Skipping llama.cpp install on macOS; extras do not require it');
      }
    } else {
      log.info('[PythonEnvManager] No bundled GPU wheels available for platform %s', process.platform);
    }

    if (!wheelEntries.length) {
      return;
    }

    for (const entry of wheelEntries) {
      await this.reportProgress(entry.progressStep, entry.progressValue, `Installing bundled ${entry.label} wheel...`);
    }

    try {
      const installArgs = ['pip', 'install', ...wheelEntries.map((entry) => entry.path)];
      await this.runUvCommand(
        uvPath,
        envPath,
        installArgs,
        `Installing bundled GPU wheels (${wheelEntries.map((entry) => entry.label).join(', ')})`
      );
      wheelEntries.forEach((entry) => {
        log.info(`[PythonEnvManager] Bundled ${entry.label} wheel installed successfully`);
      });
    } catch (error) {
      log.warn('[PythonEnvManager] Failed to install bundled GPU wheels; falling back to default behaviour:', error);
    }
  }

  /**
   * Get the user app data directory for storing the Python environment
   */
  private getUserDataDir(): string {
    const platform = process.platform;
    const homeDir = os.homedir();
    
    switch (platform) {
      case 'darwin':
        return path.join(homeDir, 'Library', 'Application Support', 'Chatterley');
      case 'win32':
        return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Chatterley');
      case 'linux':
        return path.join(process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'Chatterley');
      default:
        return path.join(homeDir, '.chatterley');
    }
  }

  /**
   * Ensure the bundled Oumi sources are available in a writable location.
   * During Linux packaged installs the resources directory is read-only,
   * so we copy the sources into the user's application data directory.
   */
  private ensureWritableOumiSource(sourcePath: string): string {
    if (!app.isPackaged || process.platform !== 'linux') {
      return sourcePath;
    }

    try {
      const userDataDir = this.getUserDataDir();
      const copyRoot = path.join(userDataDir, 'python-src');
      const versionTag = `${app.getVersion() || 'dev'}-${process.arch}`;
      const targetPath = path.join(copyRoot, versionTag);
      const sentinel = path.join(targetPath, '.source-version');

      if (fs.existsSync(targetPath) && fs.existsSync(sentinel)) {
        const recordedVersion = fs.readFileSync(sentinel, 'utf8').trim();
        if (recordedVersion === versionTag) {
          log.info('[PythonEnvManager] Using cached writable Oumi source at %s', targetPath);
          return targetPath;
        }

        log.info(
          '[PythonEnvManager] Writable Oumi source version mismatch (%s != %s); refreshing copy.',
          recordedVersion,
          versionTag
        );
      }

      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }

      fs.mkdirSync(copyRoot, { recursive: true });
      log.info('[PythonEnvManager] Copying Oumi sources to writable directory: %s', targetPath);
      fs.cpSync(sourcePath, targetPath, { recursive: true });
      fs.writeFileSync(sentinel, versionTag);

      return targetPath;
    } catch (error) {
      log.warn(
        '[PythonEnvManager] Failed to prepare writable Oumi source (%s); falling back to bundled path.',
        error
      );
      return sourcePath;
    }
  }

  /**
   * Get the path to the bundled Python distribution
   */
  private getBundledPythonPath(): string {
    const resourcesPath = app.isPackaged 
      ? process.resourcesPath 
      : path.join(__dirname, '../..');
      
    const pythonDist = path.join(resourcesPath, 'python-dist');
    
    // In packaged apps, the platform-specific directory is flattened to python-dist/
    // During development, we maintain the nested structure
    if (app.isPackaged) {
      // Production: flattened structure (python-dist/bin/python3 or python-dist/python.exe)
      if (process.platform === 'win32') {
        return path.join(pythonDist, 'python.exe');
      } else {
        return path.join(pythonDist, 'bin', 'python3');
      }
    } else {
      // Development: nested platform directory structure
      const platform = process.platform;
      const arch = process.arch;
      
      let platformDir: string;
      if (platform === 'darwin') {
        platformDir = `darwin-${arch}`; // darwin-arm64, darwin-x64
      } else if (platform === 'win32') {
        platformDir = `win32-${arch}`;  // win32-x64
      } else {
        platformDir = `linux-${arch}`;  // linux-x64
      }
      
      // Find the Python executable in the platform-specific directory
      if (platform === 'win32') {
        return path.join(pythonDist, platformDir, 'python.exe');
      } else {
        return path.join(pythonDist, platformDir, 'bin', 'python');
      }
    }
  }

  /**
   * Get the path where we'll create the Chatterley Python environment
   */
  private getEnvironmentPath(): string {
    return path.join(this.getUserDataDir(), 'python-env');
  }

  /**
   * Get info file path for storing environment metadata
   */
  private getEnvironmentInfoPath(): string {
    return path.join(this.getEnvironmentPath(), 'chatterley-env-info.json');
  }

  /**
   * Check if the Python environment already exists and is valid
   */
  public async checkEnvironment(): Promise<EnvironmentInfo> {
    const envPath = this.getEnvironmentPath();
    const infoPath = this.getEnvironmentInfoPath();
    
    log.info(`[PythonEnvManager] Checking environment at: ${envPath}`);
    
    const result: EnvironmentInfo = {
      path: envPath,
      pythonPath: '',
      isValid: false
    };

    if (!fs.existsSync(envPath)) {
      log.info('[PythonEnvManager] Environment directory does not exist');
      return result;
    }

    // Find Python executable in the environment
    const platform = process.platform;
    const pythonExe = platform === 'win32' 
      ? path.join(envPath, 'Scripts', 'python.exe')
      : path.join(envPath, 'bin', 'python');
    
    if (!fs.existsSync(pythonExe)) {
      log.info('[PythonEnvManager] Python executable not found in environment');
      return result;
    }

    result.pythonPath = pythonExe;

    // Load environment info if available
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        result.createdAt = info.createdAt;
        result.lastUsed = info.lastUsed;
        result.systemInfo = info.systemInfo;
        if (info.systemInfo) {
          this.cachedSystemInfo = info.systemInfo;
          this.configureWindowsCudaRuntime(this.getWindowsWheelProfile());
        }
      } catch (error) {
        log.warn('[PythonEnvManager] Failed to read environment info:', error);
      }
    }

    // Test if the environment is functional
    try {
      const isValid = await this.testEnvironment(pythonExe);
      result.isValid = isValid;
      
      if (isValid) {
        // Update last used timestamp, preserving system info
        await this.updateEnvironmentInfo({
          createdAt: result.createdAt || new Date().toISOString(),
          lastUsed: new Date().toISOString(),
          systemInfo: result.systemInfo
        });
      }
      
      return result;
    } catch (error) {
      log.error('[PythonEnvManager] Environment test failed:', error);
      return result;
    }
  }

  /**
   * Test if the Python environment has oumi installed and working
   */
  private async testEnvironment(pythonPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const envDir = path.dirname(path.dirname(pythonPath));
      const pipPath = process.platform === 'win32'
        ? path.join(envDir, 'Scripts', 'pip.exe')
        : path.join(envDir, 'bin', 'pip');

      const freezeProcess = spawn(pipPath, ['freeze'], {
        stdio: 'pipe',
        timeout: 10000,
      });

      let freezeOutput = '';
      freezeProcess.stdout?.on('data', (data) => {
        freezeOutput += data.toString();
      });
      freezeProcess.on('close', (code) => {
        const trimmed = freezeOutput.trim();
        if (!trimmed) {
          log.info(`[PythonEnvManager] pip freeze (code ${code}): <no output>`);
          return;
        }
        const lines = trimmed.split(/\r?\n/);
        log.info(`[PythonEnvManager] pip freeze (code ${code}) - ${lines.length} entries`);
        for (const line of lines) {
          log.info(`[PythonEnvManager] pip freeze >> ${line}`);
        }
      });
      freezeProcess.on('error', (error) => {
        log.warn('[PythonEnvManager] pip freeze failed:', error);
      });

      const testProcess = spawn(pythonPath, ['-c', 'import oumi; print("OK")'], {
        stdio: 'pipe',
        timeout: 10000
      });

      let output = '';
      let hasOutput = false;

      testProcess.stdout?.on('data', (data) => {
        output += data.toString();
        hasOutput = true;
      });

      testProcess.on('close', (code) => {
        const success = code === 0 && hasOutput && output.trim().includes('OK');
        log.info(`[PythonEnvManager] Environment test result: ${success} (code: ${code}, output: ${output.trim()})`);
        resolve(success);
      });

      testProcess.on('error', (error) => {
        log.error('[PythonEnvManager] Environment test error:', error);
        resolve(false);
      });
    });
  }

  /**
   * Set up the Python environment from scratch
   */
  public async setupEnvironment(): Promise<EnvironmentInfo> {
    if (this.isSettingUp) {
      throw new Error('Environment setup already in progress');
    }

    this.isSettingUp = true;
    log.info('[PythonEnvManager] Starting environment setup...');

    try {
      // Step 1: Check bundled Python exists
      await this.reportProgress('checking', 5, 'Checking bundled Python...');
      const bundledPython = this.getBundledPythonPath();
      
      if (!fs.existsSync(bundledPython)) {
        throw new Error(`Bundled Python not found at: ${bundledPython}`);
      }

      // Step 2: Create environment directory
      await this.reportProgress('creating', 15, 'Creating environment directory...');
      const envPath = this.getEnvironmentPath();
      
      // Clean existing environment if it exists
      if (fs.existsSync(envPath)) {
        log.info('[PythonEnvManager] Removing existing environment');
        fs.rmSync(envPath, { recursive: true, force: true });
      }
      
      fs.mkdirSync(envPath, { recursive: true });

      // Step 3: Create virtual environment
      await this.reportProgress('venv', 25, 'Creating virtual environment...');
      await this.createVirtualEnvironment(bundledPython, envPath);

      // Step 4: Get environment Python path
      const platform = process.platform;
      const envPython = platform === 'win32' 
        ? path.join(envPath, 'Scripts', 'python.exe')
        : path.join(envPath, 'bin', 'python');

      // Step 5: Install uv
      await this.reportProgress('uv', 45, 'Installing uv package manager...');
      await this.installUv(envPython);

      // Step 5.5: Ensure Git availability (required for git-based extras)
      await this.reportProgress('git', 55, 'Ensuring Git is available...');
      await this.ensureGitAvailable(envPath);

      // Step 6: Install oumi dependencies
      await this.reportProgress('oumi', 65, 'Installing Oumi dependencies...');
      try {
        await this.installOumiDependencies(envPython, envPath);
      } catch (error) {
        log.error('[PythonEnvManager] Environment setup failed during Oumi installation:', error);
        throw error; // Re-throw to be caught by outer catch block
      }

      // Step 7: Test installation
      await this.reportProgress('testing', 90, 'Testing installation...');
      const isValid = await this.testEnvironment(envPython);
      
      if (!isValid) {
        throw new Error('Environment test failed after installation');
      }

      // Step 8: Detect system information and save environment info
      await this.reportProgress('finishing', 95, 'Detecting system capabilities...');
      
      let systemInfo: SystemInfo;
    try {
      systemInfo = await SystemDetector.detectSystem();
      this.cachedSystemInfo = systemInfo;
      log.info('[PythonEnvManager] System detection completed:', {
        platform: systemInfo.platform,
        architecture: systemInfo.architecture,
        totalRAM: `${systemInfo.totalRAM}GB`,
        cudaAvailable: systemInfo.cudaAvailable,
          cudaDevices: systemInfo.cudaDevices.length
        });
      } catch (error) {
        log.warn('[PythonEnvManager] System detection failed:', error);
        // Create minimal system info if detection fails
        systemInfo = {
          architecture: process.arch,
          platform: process.platform,
          platformVersion: 'Unknown',
          cpuModel: 'Unknown',
          totalRAM: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
        availableRAM: Math.round(os.freemem() / (1024 * 1024 * 1024)),
        cudaAvailable: false,
        cudaDevices: [],
        detectedAt: new Date().toISOString(),
        fingerprint: 'unknown'
      };
      this.cachedSystemInfo = systemInfo;
    }
      
      const now = new Date().toISOString();
      await this.updateEnvironmentInfo({
        createdAt: now,
        lastUsed: now,
        systemInfo
      });

      await this.reportProgress('complete', 100, 'Setup complete!', true);

      log.info('[PythonEnvManager] Environment setup completed successfully');
      
      return {
        path: envPath,
        pythonPath: envPython,
        isValid: true,
        createdAt: now,
        lastUsed: now,
        systemInfo
      };

    } catch (error) {
      log.error('[PythonEnvManager] Environment setup failed:', error);
      throw error;
    } finally {
      this.isSettingUp = false;
      this.setupProcess = null;
    }
  }

  /**
   * Create virtual environment using bundled Python
   */
  private async createVirtualEnvironment(pythonPath: string, envPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const venvProcess = spawn(pythonPath, ['-m', 'venv', envPath], {
        stdio: 'pipe'
      });

      let stderr = '';
      
      venvProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      venvProcess.on('close', (code) => {
        if (code === 0) {
          log.info('[PythonEnvManager] Virtual environment created successfully');
          resolve();
        } else {
          log.error(`[PythonEnvManager] Virtual environment creation failed with code ${code}`);
          log.error(`[PythonEnvManager] Stderr: ${stderr}`);
          reject(new Error(`Failed to create virtual environment: ${stderr}`));
        }
      });

      venvProcess.on('error', (error) => {
        log.error('[PythonEnvManager] Virtual environment creation error:', error);
        reject(error);
      });
    });
  }

  /**
   * Install uv package manager
   */
  private async installUv(pythonPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const installProcess = spawn(pythonPath, ['-m', 'pip', 'install', 'uv'], {
        stdio: 'pipe'
      });

      this.setupProcess = installProcess;
      let stderr = '';
      
      installProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      installProcess.on('close', (code) => {
        if (code === 0) {
          log.info('[PythonEnvManager] uv installed successfully');
          resolve();
        } else {
          log.error(`[PythonEnvManager] uv installation failed with code ${code}`);
          log.error(`[PythonEnvManager] Stderr: ${stderr}`);
          reject(new Error(`Failed to install uv: ${stderr}`));
        }
      });

      installProcess.on('error', (error) => {
        log.error('[PythonEnvManager] uv installation error:', error);
        reject(error);
      });
    });
  }

  /**
   * Determine required extras based on system capabilities
   */
  private async getRequiredExtras(): Promise<string[]> {
    const extras: string[] = [];
    
    // Always include interactive (for prompt_toolkit, etc.)
    extras.push('interactive');

    // Ensure multimodal/omni dependencies are available for audio/video models
    if (!extras.includes('omni')) {
      extras.push('omni');
    }

    // Pull in diffusers/image extras so the bundled environment can run image synthesis APIs
    if (!extras.includes('image_generation')) {
      extras.push('image_generation');
    }
    
    try {
      // Detect system capabilities
      const systemInfo = await SystemDetector.detectSystem();
      this.cachedSystemInfo = systemInfo;
      this.configureWindowsCudaRuntime(this.getWindowsWheelProfile());

      if (systemInfo.cudaAvailable && systemInfo.cudaDevices.length > 0) {
        if (systemInfo.platform === 'win32') {
          if (!extras.includes('llama_cpp')) {
            extras.push('llama_cpp');
          }
          log.info(
            `[PythonEnvManager] CUDA detected on Windows: ${systemInfo.cudaDevices.length} device(s) - enabling llama_cpp (vLLM is disabled on Windows)`
          );
        } else {
          // Non-Windows platforms: use full GPU stack + quantization
          extras.push('gpu', 'quantization');
          log.info(`[PythonEnvManager] CUDA detected: ${systemInfo.cudaDevices.length} device(s) - including GPU extras`);

          if (systemInfo.platform === 'linux') {
            if (!extras.includes('ci_cpu')) {
              extras.push('ci_cpu');
              log.info('[PythonEnvManager] Including ci_cpu extras alongside GPU for Linux builds');
            }
          }
        }
      } else {
        if (systemInfo.platform === 'linux') {
          log.info('[PythonEnvManager] No CUDA detected on Linux - skipping llama_cpp extras and using ci_cpu only');
          if (!extras.includes('ci_cpu')) {
            extras.push('ci_cpu');
          }
        } else {
          // Non-Linux platforms fall back to llama_cpp for CPU inference
          extras.push('llama_cpp');
          log.info('[PythonEnvManager] No CUDA detected - including llama_cpp for CPU-only installation');
        }
      }

    } catch (error) {
      log.warn('[PythonEnvManager] System detection failed, using safe defaults:', error);
      // If system detection fails, use conservative approach

      // Add llama_cpp for CPU inference as fallback
      if (process.platform !== 'linux' && !extras.includes('llama_cpp')) {
        extras.push('llama_cpp');
      }

      // Add ci_cpu only for Linux as a safe fallback (avoid Windows due to vLLM)
      if (process.platform === 'linux') {
        extras.push('ci_cpu');
      }
    }
    
    return extras;
  }

  /**
   * Install Oumi and dependencies using uv
   */
  private async installOumiDependencies(pythonPath: string, envPath: string): Promise<void> {
    // Get path to bundled oumi source
    const resourcesPath = app.isPackaged 
      ? process.resourcesPath 
      : path.join(__dirname, '../..');  // In development, use frontend root

    let oumiSourcePath: string;
    if (app.isPackaged) {
      // In packaged app: resources/python/ (contains pyproject.toml)
      oumiSourcePath = path.join(resourcesPath, 'python');
    } else {
      const isDistBuild = __dirname.includes(`${path.sep}dist${path.sep}electron`);
      const repoRoot = isDistBuild
        ? path.resolve(__dirname, '../../../../')
        : path.resolve(__dirname, '../../..');
      const newLayoutPath = path.join(repoRoot, 'backend', 'oumi');
      if (fs.existsSync(newLayoutPath)) {
        oumiSourcePath = newLayoutPath;
      } else {
        // Legacy fallback when frontend and backend coexisted under oumi/
        const legacyPath = isDistBuild
          ? path.resolve(__dirname, '../../../')
          : path.resolve(__dirname, '../../');
        oumiSourcePath = legacyPath;
      }
    }
    
    log.info(`[PythonEnvManager] Resource path: ${resourcesPath}`);
    log.info(`[PythonEnvManager] Bundled Oumi source path: ${oumiSourcePath}`);
    
    // Verify the path exists
    if (!fs.existsSync(oumiSourcePath)) {
      const errorMsg = `Oumi source path does not exist: ${oumiSourcePath}`;
      log.error(`[PythonEnvManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Verify pyproject.toml exists at bundled location
    const bundledPyprojectPath = path.join(oumiSourcePath, 'pyproject.toml');
    if (!fs.existsSync(bundledPyprojectPath)) {
      const errorMsg = `pyproject.toml not found at: ${bundledPyprojectPath}`;
      log.error(`[PythonEnvManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    let installSourcePath = oumiSourcePath;
    if (app.isPackaged && process.platform === 'linux') {
      installSourcePath = this.ensureWritableOumiSource(oumiSourcePath);
    }

    const installPyprojectPath = path.join(installSourcePath, 'pyproject.toml');
    if (!fs.existsSync(installPyprojectPath)) {
      const errorMsg = `pyproject.toml not found at: ${installPyprojectPath}`;
      log.error(`[PythonEnvManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    log.info(`[PythonEnvManager] Using Oumi source path for installation: ${installSourcePath}`);
    log.info(`[PythonEnvManager] Found pyproject.toml at: ${installPyprojectPath}`);
    
    // Determine appropriate extras based on system capabilities
    const extras = await this.getRequiredExtras();
    log.info(`[PythonEnvManager] Selected extras: ${extras.join(', ')}`);

    const installExtras = process.platform === 'win32'
      ? extras.filter((extra) => extra !== 'llama_cpp')
      : extras;

    if (installExtras.length !== extras.length) {
      log.info('[PythonEnvManager] Excluding llama_cpp extra from Windows install to preserve bundled wheel');
    }

    const installExtrasMessage = installExtras.length > 0 ? installExtras.join(', ') : 'none';
    await this.reportProgress('oumi', 70, `Installing Oumi with extras: ${installExtrasMessage}...`);

    const uvPath = process.platform === 'win32'
      ? path.join(envPath, 'Scripts', 'uv.exe')
      : path.join(envPath, 'bin', 'uv');

    await this.ensureWindowsBuildDependencies(envPath, uvPath, extras);
    await this.ensureGitAvailable(envPath);
    await this.installWindowsTorchRuntime(envPath, uvPath, pythonPath);
    await this.installPrebuiltGpuWheels(envPath, uvPath, extras, pythonPath);

    await new Promise<void>((resolve, reject) => {
      // Use uv to install oumi in development mode with appropriate extras
      const packageSpec = installExtras.length > 0 
        ? `${installSourcePath}[${installExtras.join(',')}]`  // Install with filtered extras
        : installSourcePath;                                  // Install without extras
    
      log.info(`[PythonEnvManager] Installing: ${packageSpec}`);
        
      const installProcess = spawn(uvPath, [
        'pip', 'install', 
        '-e', packageSpec,
        '-v'  // Verbose output to get more progress info
      ], {
        stdio: 'pipe',
        env: {
          ...this.buildVirtualEnvProcessEnv(envPath),
          // Set version for setuptools-scm since bundled source lacks .git directory
          SETUPTOOLS_SCM_PRETEND_VERSION_FOR_OUMI: '0.1.0'
        }
      });

      this.setupProcess = installProcess;
      let stderr = '';
      let stdout = '';
      let installedPackages = 0;
      
      installProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        
        // Log all output
        const lines = output.trim().split('\n');
        lines.forEach(async (line: string) => {
          if (line.trim()) {
            log.info(`[PythonEnvManager] Install: ${line.trim()}`);
            
            // Parse installation progress
            await this.parseInstallationProgress(line, installedPackages);
          }
        });
      });
      
      installProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        
        // Log stderr and look for progress info there too
        const lines = output.trim().split('\n');
        lines.forEach(async (line: string) => {
          if (line.trim()) {
            log.info(`[PythonEnvManager] Install stderr: ${line.trim()}`);
            
            // Parse installation progress from stderr too
            await this.parseInstallationProgress(line, installedPackages);
          }
        });
      });

      installProcess.on('close', (code) => {
        if (code === 0) {
          log.info('[PythonEnvManager] Oumi dependencies installed successfully');
          resolve();
        } else {
          log.error(`[PythonEnvManager] Oumi installation failed with code ${code}`);
          log.error(`[PythonEnvManager] Stderr: ${stderr}`);
          reject(new Error(`Failed to install oumi: ${stderr}`));
        }
      });

      installProcess.on('error', (error) => {
        log.error('[PythonEnvManager] Oumi installation error:', error);
        reject(error);
      });
    });

    await this.disableLigerKernelForLinux(envPath, uvPath, extras);
  }

  /**
   * Remove the Liger kernel dependency on Linux since upstream wheels are unstable.
   */
  private async disableLigerKernelForLinux(envPath: string, uvPath: string, extras: string[]): Promise<void> {
    if (process.platform !== 'linux') {
      return;
    }

    const normalized = extras.map((extra) => extra.toLowerCase());
    const requiresRemoval =
      normalized.includes('gpu') ||
      normalized.includes('liger_kernel') ||
      normalized.includes('liger-kernel');

    if (!requiresRemoval) {
      log.info('[PythonEnvManager] Liger kernel not requested by extras; nothing to remove.');
      return;
    }

    try {
      await this.reportProgress('oumi', 82, 'Removing unsupported Liger kernel dependency for Linux...');
      await this.runUvCommand(
        uvPath,
        envPath,
        ['pip', 'uninstall', '-y', 'liger-kernel'],
        'Removing liger-kernel package for Linux compatibility'
      );
      log.info('[PythonEnvManager] Liger kernel successfully removed for Linux build.');
    } catch (error) {
      log.warn('[PythonEnvManager] Failed to remove liger-kernel (continuing without it):', error);
    }
  }

  /**
   * Parse installation progress from uv output and report to UI
   */
  private async parseInstallationProgress(line: string, installedPackages: number): Promise<void> {
    try {
      // Look for package download/install patterns
      if (line.includes('Downloading') && line.includes('(')) {
        const packageMatch = line.match(/Downloading\s+([^\s]+)/);
        if (packageMatch) {
          const packageName = packageMatch[1];
          await this.reportProgress('oumi', 75 + (installedPackages * 2), `Downloading ${packageName}...`);
        }
      } else if (line.includes('Installing') && line.includes('(')) {
        const packageMatch = line.match(/Installing\s+([^\s]+)/);
        if (packageMatch) {
          const packageName = packageMatch[1];
          installedPackages++;
          await this.reportProgress('oumi', 75 + (installedPackages * 2), `Installing ${packageName}...`);
        }
      } else if (line.includes('Collecting')) {
        const packageMatch = line.match(/Collecting\s+([^\s]+)/);
        if (packageMatch) {
          const packageName = packageMatch[1];
          await this.reportProgress('oumi', 70 + (installedPackages * 1), `Resolving dependencies for ${packageName}...`);
        }
      } else if (line.includes('Building wheel')) {
        const packageMatch = line.match(/Building wheel.*?for\s+([^\s]+)/);
        if (packageMatch) {
          const packageName = packageMatch[1];
          await this.reportProgress('oumi', 80 + (installedPackages * 1), `Building ${packageName}...`);
        }
      } else if (line.includes('Successfully installed')) {
        await this.reportProgress('oumi', 85, 'Installation completed, verifying packages...');
      } else if (line.toLowerCase().includes('resolving') || line.toLowerCase().includes('downloading')) {
        // Generic progress for any resolving/downloading activity
        await this.reportProgress('oumi', 72, 'Resolving package dependencies...');
      }
    } catch (error) {
      // Don't let progress parsing errors fail the installation
      log.warn('[PythonEnvManager] Error parsing installation progress:', error);
    }
  }

  /**
   * Update environment info file
   */
  private async updateEnvironmentInfo(info: { createdAt: string; lastUsed: string; systemInfo?: SystemInfo }): Promise<void> {
    const infoPath = this.getEnvironmentInfoPath();
    const os = require('os');
    
    // Debug architecture detection
    log.info('[PythonEnvManager] Architecture Detection Debug:');
    log.info(`  process.arch: ${process.arch}`);
    log.info(`  os.arch(): ${os.arch()}`);
    log.info(`  process.platform: ${process.platform}`);
    
    // If systemInfo is not provided, detect it now
    let systemInfo = info.systemInfo;
    if (!systemInfo) {
      log.info('[PythonEnvManager] SystemInfo not provided, detecting now...');
      try {
        const { SystemDetector } = await import('./system-detector');
        systemInfo = await SystemDetector.detectSystem();
        this.cachedSystemInfo = systemInfo;
        log.info('[PythonEnvManager] SystemInfo detected:', systemInfo);
      } catch (error) {
        log.error('[PythonEnvManager] Failed to detect system info:', error);
        // Create minimal system info as fallback
        systemInfo = {
          platform: process.platform,
          architecture: process.arch,
          cpuModel: 'Unknown',
          totalRAM: 0,
          availableRAM: 0,
          platformVersion: 'Unknown',
          cudaAvailable: false,
          cudaDevices: [],
          detectedAt: new Date().toISOString(),
          fingerprint: 'unknown'
        };
        this.cachedSystemInfo = systemInfo;
      }
    }
    
    const envInfo = {
      version: '1.1', // Updated version to include system info
      platform: process.platform,
      arch: process.arch, // Use process.arch consistently everywhere
      ...info,
      systemInfo // Ensure systemInfo is always included
    };
    
    try {
      fs.writeFileSync(infoPath, JSON.stringify(envInfo, null, 2));
      log.info('[PythonEnvManager] Environment info updated with arch:', envInfo.arch);
      log.info('[PythonEnvManager] Environment info updated with systemInfo:', !!envInfo.systemInfo);
    } catch (error) {
      log.warn('[PythonEnvManager] Failed to update environment info:', error);
    }
  }

  /**
   * Report progress to callback if available
   */
  private async reportProgress(step: string, progress: number, message: string, isComplete = false): Promise<void> {
    if (this.progressCallback) {
      this.progressCallback({
        step,
        progress,
        message,
        isComplete
      });
    }
    
    // Small delay to ensure UI updates
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Set progress callback for setup updates
   */
  public setProgressCallback(callback: (progress: SetupProgress) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Cancel ongoing setup
   */
  public cancelSetup(): void {
    if (this.setupProcess) {
      log.info('[PythonEnvManager] Cancelling setup...');
      this.setupProcess.kill('SIGTERM');
      this.setupProcess = null;
    }
    this.isSettingUp = false;
  }

  /**
   * Check if setup is currently in progress
   */
  public isSetupInProgress(): boolean {
    return this.isSettingUp;
  }

  /**
   * Get user data directory path for display to user
   */
  public getUserDataPath(): string {
    return this.getUserDataDir();
  }

  /**
   * Remove the Python environment (cleanup)
   */
  public async removeEnvironment(): Promise<void> {
    const envPath = this.getEnvironmentPath();
    if (fs.existsSync(envPath)) {
      log.info('[PythonEnvManager] Removing Python environment');
      fs.rmSync(envPath, { recursive: true, force: true });
    }
  }

  /**
   * Check if the system has changed significantly since environment creation
   */
  public async checkSystemChanges(environmentInfo: EnvironmentInfo): Promise<{ hasChanged: boolean; changes: string[]; shouldRebuild: boolean }> {
    try {
      if (!environmentInfo.systemInfo) {
        return { 
          hasChanged: true, 
          changes: ['No system information available from previous setup'],
          shouldRebuild: true 
        };
      }

      const currentSystem = await SystemDetector.detectSystem();
      this.cachedSystemInfo = currentSystem;
      const oldSystem = environmentInfo.systemInfo;
      const changes: string[] = [];
      
      // Check for significant changes
      if (oldSystem.platform !== currentSystem.platform) {
        changes.push(`Platform changed from ${oldSystem.platform} to ${currentSystem.platform}`);
      }
      
      if (oldSystem.architecture !== currentSystem.architecture) {
        changes.push(`Architecture changed from ${oldSystem.architecture} to ${currentSystem.architecture}`);
      }
      
      // Check CUDA availability changes
      if (oldSystem.cudaAvailable !== currentSystem.cudaAvailable) {
        const status = currentSystem.cudaAvailable ? 'available' : 'unavailable';
        const oldStatus = oldSystem.cudaAvailable ? 'available' : 'unavailable';
        changes.push(`CUDA changed from ${oldStatus} to ${status}`);
      }
      
      // Check CUDA device changes (if CUDA is available)
      if (currentSystem.cudaAvailable && oldSystem.cudaAvailable) {
        const oldDeviceCount = oldSystem.cudaDevices.length;
        const newDeviceCount = currentSystem.cudaDevices.length;
        
        if (oldDeviceCount !== newDeviceCount) {
          changes.push(`CUDA device count changed from ${oldDeviceCount} to ${newDeviceCount}`);
        }
        
        // Check total VRAM changes
        const oldVRAM = oldSystem.cudaDevices.reduce((sum, device) => sum + device.vram, 0);
        const newVRAM = currentSystem.cudaDevices.reduce((sum, device) => sum + device.vram, 0);
        const vramDiff = Math.abs(oldVRAM - newVRAM);
        
        if (vramDiff > 1) { // More than 1GB difference
          changes.push(`Total VRAM changed from ${oldVRAM.toFixed(1)}GB to ${newVRAM.toFixed(1)}GB`);
        }
      }
      
      // Check significant RAM changes (more than 25% difference)
      const ramDiff = Math.abs(oldSystem.totalRAM - currentSystem.totalRAM);
      if (ramDiff > oldSystem.totalRAM * 0.25) {
        changes.push(`RAM changed from ${oldSystem.totalRAM}GB to ${currentSystem.totalRAM}GB`);
      }
      
      // Determine if rebuild is recommended
      const shouldRebuild = changes.some(change => 
        change.includes('Platform changed') || 
        change.includes('Architecture changed') ||
        change.includes('CUDA changed') ||
        change.includes('device count changed')
      );
      
      return {
        hasChanged: changes.length > 0,
        changes,
        shouldRebuild
      };
      
    } catch (error) {
      log.error('[PythonEnvManager] Error checking system changes:', error);
      return { 
        hasChanged: true, 
        changes: ['Unable to detect system changes'],
        shouldRebuild: false 
      };
    }
  }

  /**
   * Query which backends are installed inside the managed environment
   */
  public async getInstalledBackends(): Promise<{ sglang: boolean; vllm: boolean; llamacpp: boolean }> {
    const envInfo = await this.checkEnvironment();
    const baseResult = { sglang: false, vllm: false, llamacpp: false };

    if (!envInfo.isValid || !envInfo.pythonPath) {
      return this.applyWindowsBackendDefaults(baseResult);
    }

    return await new Promise((resolve) => {
      const code = `import json, importlib.util as u;\nprint(json.dumps({\n  'sglang': bool(u.find_spec('sglang')),\n  'vllm': bool(u.find_spec('vllm')),\n  'llamacpp': bool(u.find_spec('llama_cpp'))\n}))`;
      const p = spawn(envInfo.pythonPath, ['-c', code], { stdio: 'pipe' });
      let out = '';
      p.stdout?.on('data', (d) => out += String(d));
      p.on('close', () => {
        try {
          const parsed = JSON.parse(out.trim());
          resolve(this.applyWindowsBackendDefaults({
            sglang: !!parsed.sglang,
            vllm: !!parsed.vllm,
            llamacpp: !!parsed.llamacpp
          }));
        } catch {
          resolve(this.applyWindowsBackendDefaults(baseResult));
        }
      });
      p.on('error', () => resolve(this.applyWindowsBackendDefaults(baseResult)));
    });
  }

  /**
   * Force rebuild the Python environment
   * This will delete the existing environment and recreate it from scratch
   */
  public async rebuildEnvironment(): Promise<EnvironmentInfo> {
    try {
      log.info('[PythonEnvManager] Starting environment rebuild');
      
      // Cancel any ongoing setup
      if (this.setupProcess) {
        this.setupProcess.kill();
        this.setupProcess = null;
      }
      
      // Remove the existing environment
      await this.removeEnvironment();
      
      // Report that we're starting the rebuild
      await this.reportProgress('checking', 0, 'Starting environment rebuild...');
      
      // Set up the environment from scratch
      return await this.setupEnvironment();
    } catch (error) {
      log.error('[PythonEnvManager] Error during environment rebuild:', error);
      throw error;
    }
  }

  /**
   * Ensure SGLang backend is installed in the managed environment
   */
  public async installSGLangBackend(): Promise<void> {
    // Ensure environment exists and is valid
    const envInfo = await this.checkEnvironment();
    let pythonPath = envInfo.pythonPath;
    const envPath = this.getEnvironmentPath();

    if (!envInfo.isValid || !pythonPath) {
      // Create environment if missing/invalid
      const setup = await this.setupEnvironment();
      pythonPath = setup.pythonPath;
    }

    // Determine uv path inside the venv
    const uvPath = path.join(envPath, 'bin', 'uv');

    // Install uv if missing
    if (!fs.existsSync(uvPath)) {
      await this.reportProgress('sglang', 5, 'Installing uv package manager...');
      await this.installUv(pythonPath);
    }

    await this.ensureGitAvailable(envPath);
    await this.reportProgress('sglang', 15, 'Installing SGLang backend...');

    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn(uvPath, [
        'pip', 'install',
        'sglang',
        '-v'
      ], {
        stdio: 'pipe',
        env: {
          ...process.env,
          VIRTUAL_ENV: envPath,
          PATH: `${path.dirname(uvPath)}:${process.env.PATH}`,
        }
      });

      let stderr = '';
      let stdout = '';
      
      installProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
        const line = data.toString().trim();
        if (line) {
          log.info(`[PythonEnvManager] SGLang install: ${line}`);
        }
      });
      
      installProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line) {
          log.info(`[PythonEnvManager] SGLang install stderr: ${line}`);
        }
      });

      installProcess.on('close', async (code) => {
        if (code === 0) {
          await this.reportProgress('sglang', 90, 'Verifying SGLang installation...');
          try {
            // Quick import check inside the environment
            const checkProc = spawn(pythonPath, ['-c', 'import sglang; print("OK")'], { stdio: 'pipe' });
            let ok = false;
            checkProc.stdout?.on('data', (d) => { if (String(d).includes('OK')) ok = true; });
            checkProc.on('close', async () => {
              if (ok) {
                await this.reportProgress('sglang', 100, 'SGLang installation complete', true);
                resolve();
              } else {
                reject(new Error('SGLang import test failed'));
              }
            });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        } else {
          log.error('[PythonEnvManager] SGLang installation failed:', stderr);
          reject(new Error(stderr || 'Failed to install SGLang'));
        }
      });

      installProcess.on('error', (error) => {
        log.error('[PythonEnvManager] SGLang installation error:', error);
        reject(error);
      });
    });
  }

  /**
   * Attempt to install FlashAttention 2 (CUDA-only on supported platforms)
   */
  public async installFlashAttention2(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('FlashAttention 2 install is only supported on Linux');
    }
    const envInfo = await this.checkEnvironment();
    let pythonPath = envInfo.pythonPath;
    const envPath = this.getEnvironmentPath();

    if (!envInfo.isValid || !pythonPath) {
      const setup = await this.setupEnvironment();
      pythonPath = setup.pythonPath;
    }

    const uvPath = path.join(envPath, 'bin', 'uv');

    if (!fs.existsSync(uvPath)) {
      await this.reportProgress('flash-attn2', 5, 'Installing uv package manager...');
      await this.installUv(pythonPath);
    }

    await this.ensureGitAvailable(envPath);
    await this.reportProgress('flash-attn2', 15, 'Installing FlashAttention 2 (flash-attn)...');

    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn(uvPath, [
        'pip', 'install',
        'flash-attn',
        '--no-build-isolation',
        '-v'
      ], {
        stdio: 'pipe',
        env: {
          ...process.env,
          VIRTUAL_ENV: envPath,
          PATH: `${path.dirname(uvPath)}:${process.env.PATH}`,
        }
      });

      let stderr = '';
      
      installProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line) log.info(`[PythonEnvManager] flash-attn stderr: ${line}`);
      });

      installProcess.stdout?.on('data', (data) => {
        const line = data.toString().trim();
        if (line) log.info(`[PythonEnvManager] flash-attn: ${line}`);
      });

      installProcess.on('close', async (code) => {
        if (code === 0) {
          await this.reportProgress('flash-attn2', 100, 'FlashAttention 2 installation attempted', true);
          resolve();
        } else {
          log.error('[PythonEnvManager] flash-attn install failed:', stderr);
          reject(new Error(stderr || 'Failed to install flash-attn'));
        }
      });

      installProcess.on('error', (error) => {
        log.error('[PythonEnvManager] flash-attn installation error:', error);
        reject(error);
      });
    });
  }

  /**
   * Attempt to install flashinfer
   */
  public async installFlashInfer(): Promise<void> {
    const envInfo = await this.checkEnvironment();
    let pythonPath = envInfo.pythonPath;
    const envPath = this.getEnvironmentPath();

    if (!envInfo.isValid || !pythonPath) {
      const setup = await this.setupEnvironment();
      pythonPath = setup.pythonPath;
    }

    const uvPath = path.join(envPath, 'bin', 'uv');

    if (!fs.existsSync(uvPath)) {
      await this.reportProgress('flash-infer', 5, 'Installing uv package manager...');
      await this.installUv(pythonPath);
    }

    await this.ensureGitAvailable(envPath);
    await this.reportProgress('flash-infer', 15, 'Installing flashinfer-python...');

    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn(uvPath, [
        'pip', 'install',
        'flashinfer-python',
        '--no-build-isolation',
        '-v'
      ], {
        stdio: 'pipe',
        env: {
          ...process.env,
          VIRTUAL_ENV: envPath,
          PATH: `${path.dirname(uvPath)}:${process.env.PATH}`,
        }
      });

      let stderr = '';

      installProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line) log.info(`[PythonEnvManager] flashinfer stderr: ${line}`);
      });

      installProcess.stdout?.on('data', (data) => {
        const line = data.toString().trim();
        if (line) log.info(`[PythonEnvManager] flashinfer: ${line}`);
      });

      installProcess.on('close', async (code) => {
        if (code === 0) {
          await this.reportProgress('flash-infer', 100, 'flashinfer installation attempted', true);
          resolve();
        } else {
          log.error('[PythonEnvManager] flashinfer install failed:', stderr);
          reject(new Error(stderr || 'Failed to install flashinfer'));
        }
      });

      installProcess.on('error', (error) => {
        log.error('[PythonEnvManager] flashinfer installation error:', error);
        reject(error);
      });
    });
  }
}
