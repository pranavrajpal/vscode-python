import * as fsapi from 'fs-extra';
import * as path from 'path';
import { lt, parse, SemVer } from 'semver';
import { getEnvironmentVariable, getOSType, getUserHomeDir, OSType } from '../../../common/utils/platform';
import { arePathsSame, exec, getPythonSetting, isParentPath, pathExists, readFile } from '../externalDependencies';

import { PythonVersion, UNKNOWN_PYTHON_VERSION } from '../../base/info';
import { parseVersion } from '../../base/info/pythonVersion';

import { getRegistryInterpreters } from '../windowsUtils';
import { EnvironmentType, PythonEnvironment } from '../../info';
import { cache } from '../../../common/utils/decorators';
import { isTestExecution } from '../../../common/constants';
import { traceError, traceVerbose } from '../../../logging';
import { _SCRIPTS_DIR } from '../../../common/process/internal/scripts/constants';

export const AnacondaCompanyName = 'Anaconda, Inc.';

export type CondaEnvironmentInfo = {
    name: string;
    path: string;
};

// This type corresponds to the output of "conda info --json", and property
// names must be spelled exactly as they are in order to match the schema.
export type CondaInfo = {
    envs?: string[];
    envs_dirs?: string[]; // eslint-disable-line camelcase
    'sys.version'?: string;
    'sys.prefix'?: string;
    python_version?: string; // eslint-disable-line camelcase
    default_prefix?: string; // eslint-disable-line camelcase
    root_prefix?: string; // eslint-disable-line camelcase
    conda_version?: string; // eslint-disable-line camelcase
};

type CondaEnvInfo = {
    prefix: string;
    name?: string;
};

/**
 * Return the list of conda env interpreters.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function parseCondaInfo(
    info: CondaInfo,
    getPythonPath: (condaEnv: string) => string,
    fileExists: (filename: string) => Promise<boolean>,
    getPythonInfo: (python: string) => Promise<Partial<PythonEnvironment> | undefined>,
) {
    // The root of the conda environment is itself a Python interpreter
    // envs reported as e.g.: /Users/bob/miniconda3/envs/someEnv.
    const envs = Array.isArray(info.envs) ? info.envs : [];
    if (info.default_prefix && info.default_prefix.length > 0) {
        envs.push(info.default_prefix);
    }

    const promises = envs.map(async (envPath) => {
        const pythonPath = getPythonPath(envPath);

        if (!(await fileExists(pythonPath))) {
            return undefined;
        }
        const details = await getPythonInfo(pythonPath);
        if (!details) {
            return undefined;
        }

        return {
            ...(details as PythonEnvironment),
            path: pythonPath,
            companyDisplayName: AnacondaCompanyName,
            envType: EnvironmentType.Conda,
            envPath,
        };
    });

    return Promise.all(promises)
        .then((interpreters) => interpreters.filter((interpreter) => interpreter !== null && interpreter !== undefined))

        .then((interpreters) => interpreters.map((interpreter) => interpreter!));
}

function getCondaMetaPaths(interpreterPath: string): string[] {
    const condaMetaDir = 'conda-meta';

    // Check if the conda-meta directory is in the same directory as the interpreter.
    // This layout is common in Windows.
    // env
    // |__ conda-meta  <--- check if this directory exists
    // |__ python.exe  <--- interpreterPath
    const condaEnvDir1 = path.join(path.dirname(interpreterPath), condaMetaDir);

    // Check if the conda-meta directory is in the parent directory relative to the interpreter.
    // This layout is common on linux/Mac.
    // env
    // |__ conda-meta  <--- check if this directory exists
    // |__ bin
    //     |__ python  <--- interpreterPath
    const condaEnvDir2 = path.join(path.dirname(path.dirname(interpreterPath)), condaMetaDir);

    // The paths are ordered in the most common to least common
    return [condaEnvDir1, condaEnvDir2];
}

/**
 * Checks if the given interpreter path belongs to a conda environment. Using
 * known folder layout, and presence of 'conda-meta' directory.
 * @param {string} interpreterPath: Absolute path to any python interpreter.
 *
 * Remarks: This is what we will use to begin with. Another approach we can take
 * here is to parse ~/.conda/environments.txt. This file will have list of conda
 * environments. We can compare the interpreter path against the paths in that file.
 * We don't want to rely on this file because it is an implementation detail of
 * conda. If it turns out that the layout based identification is not sufficient
 * that is the next alternative that is cheap.
 *
 * sample content of the ~/.conda/environments.txt:
 * C:\envs\myenv
 * C:\ProgramData\Miniconda3
 *
 * Yet another approach is to use `conda env list --json` and compare the returned env
 * list to see if the given interpreter path belongs to any of the returned environments.
 * This approach is heavy, and involves running a binary. For now we decided not to
 * take this approach, since it does not look like we need it.
 *
 * sample output from `conda env list --json`:
 * conda env list --json
 * {
 *   "envs": [
 *     "C:\\envs\\myenv",
 *     "C:\\ProgramData\\Miniconda3"
 *   ]
 * }
 */
export async function isCondaEnvironment(interpreterPath: string): Promise<boolean> {
    const condaMetaPaths = getCondaMetaPaths(interpreterPath);
    // We don't need to test all at once, testing each one here
    for (const condaMeta of condaMetaPaths) {
        if (await pathExists(condaMeta)) {
            return true;
        }
    }
    return false;
}

/**
 * Extracts version information from `conda-meta/history` near a given interpreter.
 * @param interpreterPath Absolute path to the interpreter
 *
 * Remarks: This function looks for `conda-meta/history` usually in the same or parent directory.
 * Reads the `conda-meta/history` and finds the line that contains 'python-3.9.0`. Gets the
 * version string from that lines and parses it.
 */
export async function getPythonVersionFromConda(interpreterPath: string): Promise<PythonVersion> {
    const configPaths = getCondaMetaPaths(interpreterPath).map((p) => path.join(p, 'history'));
    const pattern = /\:python-(([\d\.a-z]?)+)/;

    // We want to check each of those locations in the order. There is no need to look at
    // all of them in parallel.
    for (const configPath of configPaths) {
        if (await pathExists(configPath)) {
            try {
                const lines = (await readFile(configPath)).splitLines();

                // Sample data:
                // +defaults/linux-64::pip-20.2.4-py38_0
                // +defaults/linux-64::python-3.8.5-h7579374_1
                // +defaults/linux-64::readline-8.0-h7b6447c_0
                const pythonVersionStrings = lines
                    .map((line) => {
                        // Here we should have only lines with 'python-' in it.
                        // +defaults/linux-64::python-3.8.5-h7579374_1

                        const matches = pattern.exec(line);
                        // Typically there will be 3 matches
                        // 0: "python-3.8.5"
                        // 1: "3.8.5"
                        // 2: "5"

                        // we only need the second one
                        return matches ? matches[1] : '';
                    })
                    .filter((v) => v.length > 0);

                if (pythonVersionStrings.length > 0) {
                    const last = pythonVersionStrings.length - 1;
                    return parseVersion(pythonVersionStrings[last].trim());
                }
            } catch (ex) {
                // There is usually only one `conda-meta/history`. If we found, it but
                // failed to parse it, then just return here. No need to look for versions
                // any further.
                return UNKNOWN_PYTHON_VERSION;
            }
        }
    }

    return UNKNOWN_PYTHON_VERSION;
}

// Minimum version number of conda required to be able to use 'conda run' with '--no-capture-output' flag.
export const CONDA_RUN_VERSION = '4.9.0';
export const CONDA_ACTIVATION_TIMEOUT = 45000;
const CONDA_GENERAL_TIMEOUT = 50000;

export const CONDA_RUN_SCRIPT = path.join(_SCRIPTS_DIR, 'conda_run_script.py');

/** Wraps the "conda" utility, and exposes its functionality.
 */
export class Conda {
    /**
     * Locating conda binary is expensive, since it potentially involves spawning or
     * trying to spawn processes; so it's done lazily and asynchronously. Methods that
     * need a Conda instance should use getConda() to obtain it, and should never access
     * this property directly.
     */
    private static condaPromise: Promise<Conda | undefined> | undefined;

    /**
     * Creates a Conda service corresponding to the corresponding "conda" command.
     *
     * @param command - Command used to spawn conda. This has the same meaning as the
     * first argument of spawn() - i.e. it can be a full path, or just a binary name.
     */
    constructor(readonly command: string) {}

    public static async getConda(): Promise<Conda | undefined> {
        if (this.condaPromise === undefined || isTestExecution()) {
            this.condaPromise = Conda.locate();
        }
        return this.condaPromise;
    }

    /**
     * Locates the preferred "conda" utility on this system by considering user settings,
     * binaries on PATH, Python interpreters in the registry, and known install locations.
     *
     * @return A Conda instance corresponding to the binary, if successful; otherwise, undefined.
     */
    private static async locate(): Promise<Conda | undefined> {
        traceVerbose(`Searching for conda.`);
        const home = getUserHomeDir();
        const suffix = getOSType() === OSType.Windows ? 'Scripts\\conda.exe' : 'bin/conda';

        // Produce a list of candidate binaries to be probed by exec'ing them.
        async function* getCandidates() {
            const customCondaPath = getPythonSetting<string>('condaPath');
            if (customCondaPath && customCondaPath !== 'conda') {
                // If user has specified a custom conda path, use it first.
                yield customCondaPath;
            }
            // Check unqualified filename first, in case it's on PATH.
            yield 'conda';
            if (getOSType() === OSType.Windows) {
                yield* getCandidatesFromRegistry();
            }
            yield* getCandidatesFromKnownPaths();
            yield* getCandidatesFromEnvironmentsTxt();
        }

        async function* getCandidatesFromRegistry() {
            const interps = await getRegistryInterpreters();
            const candidates = interps
                .filter((interp) => interp.interpreterPath && interp.distroOrgName === 'ContinuumAnalytics')
                .map((interp) => path.join(path.win32.dirname(interp.interpreterPath), suffix));
            yield* candidates;
        }

        async function* getCandidatesFromKnownPaths() {
            // Check common locations. We want to look up "<prefix>/*conda*/<suffix>", where prefix and suffix
            // depend on the platform, to account for both Anaconda and Miniconda, and all possible variations.
            // The check cannot use globs, because on Windows, prefixes are absolute paths with a drive letter,
            // and the glob module doesn't understand globs with drive letters in them, producing wrong results
            // for "C:/*" etc.
            const prefixes: string[] = [];
            if (getOSType() === OSType.Windows) {
                const programData = getEnvironmentVariable('PROGRAMDATA') || 'C:\\ProgramData';
                prefixes.push(programData);
                if (home) {
                    const localAppData = getEnvironmentVariable('LOCALAPPDATA') || path.join(home, 'AppData', 'Local');
                    prefixes.push(home, path.join(localAppData, 'Continuum'));
                }
            } else {
                prefixes.push('/usr/share', '/usr/local/share', '/opt');
                if (home) {
                    prefixes.push(home, path.join(home, 'opt'));
                }
            }

            for (const prefix of prefixes) {
                let items: string[] | undefined;
                try {
                    items = await fsapi.readdir(prefix);
                } catch (ex) {
                    // Directory doesn't exist or is not readable - not an error.
                    items = undefined;
                }
                if (items !== undefined) {
                    yield* items
                        .filter((fileName) => fileName.toLowerCase().includes('conda'))
                        .map((fileName) => path.join(prefix, fileName, suffix));
                }
            }
        }

        async function* getCandidatesFromEnvironmentsTxt() {
            if (!home) {
                return;
            }

            let contents: string;
            try {
                contents = await fsapi.readFile(path.join(home, '.conda', 'environments.txt'), 'utf8');
            } catch (ex) {
                // File doesn't exist or is not readable - not an error.
                contents = '';
            }

            // Match conda behavior; see conda.gateways.disk.read.yield_lines().
            // Note that this precludes otherwise legal paths with trailing spaces.
            yield* contents
                .split(/\r?\n/g)
                .map((line) => line.trim())
                .filter((line) => line !== '' && !line.startsWith('#'))
                .map((line) => path.join(line, suffix));
        }

        // Probe the candidates, and pick the first one that exists and does what we need.
        for await (const condaPath of getCandidates()) {
            traceVerbose(`Probing conda binary: ${condaPath}`);
            const conda = new Conda(condaPath);
            try {
                await conda.getInfo();
                traceVerbose(`Found conda via filesystem probing: ${condaPath}`);
                return conda;
            } catch (ex) {
                // Failed to spawn because the binary doesn't exist or isn't on PATH, or the current
                // user doesn't have execute permissions for it, or this conda couldn't handle command
                // line arguments that we passed (indicating an old version that we do not support).
                traceVerbose('Failed to spawn conda binary', condaPath, ex);
            }
        }

        // Didn't find anything.
        traceVerbose("Couldn't locate the conda binary.");
        return undefined;
    }

    /**
     * Retrieves global information about this conda.
     * Corresponds to "conda info --json".
     */
    public async getInfo(): Promise<CondaInfo> {
        return this.getInfoCached(this.command);
    }

    /**
     * Cache result for this particular command.
     */
    @cache(30_000, true, 10_000)
    // eslint-disable-next-line class-methods-use-this
    private async getInfoCached(command: string): Promise<CondaInfo> {
        const result = await exec(command, ['info', '--json'], { timeout: CONDA_GENERAL_TIMEOUT });
        traceVerbose(`conda info --json: ${result.stdout}`);
        return JSON.parse(result.stdout);
    }

    /**
     * Retrieves list of Python environments known to this conda.
     * Corresponds to "conda env list --json", but also computes environment names.
     */
    @cache(30_000, true, 10_000)
    public async getEnvList(): Promise<CondaEnvInfo[]> {
        const info = await this.getInfo();
        const { envs } = info;
        if (envs === undefined) {
            return [];
        }

        function getName(prefix: string) {
            if (info.root_prefix && arePathsSame(prefix, info.root_prefix)) {
                return 'base';
            }

            const parentDir = path.dirname(prefix);
            if (info.envs_dirs !== undefined) {
                for (const envsDir of info.envs_dirs) {
                    if (parentDir === envsDir) {
                        return path.basename(prefix);
                    }
                }
            }

            return undefined;
        }

        return envs.map((prefix) => ({
            prefix,
            name: getName(prefix),
        }));
    }

    public async getCondaEnvironment(executable: string): Promise<CondaEnvInfo | undefined> {
        const envList = await this.getEnvList();
        return envList.find((e) => isParentPath(executable, e.prefix));
    }

    public async getRunPythonArgs(env: CondaEnvInfo): Promise<string[] | undefined> {
        const condaVersion = await this.getCondaVersion();
        if (condaVersion && lt(condaVersion, CONDA_RUN_VERSION)) {
            return undefined;
        }
        const args = [];
        if (env.name) {
            args.push('-n', env.name);
        } else {
            args.push('-p', env.prefix);
        }
        return [this.command, 'run', ...args, '--no-capture-output', 'python', CONDA_RUN_SCRIPT];
    }

    /**
     * Return the conda version. The version info is cached.
     */
    @cache(-1, true)
    public async getCondaVersion(): Promise<SemVer | undefined> {
        const info = await this.getInfo().catch<CondaInfo | undefined>(() => undefined);
        let versionString: string | undefined;
        if (info && info.conda_version) {
            versionString = info.conda_version;
        } else {
            const stdOut = await exec(this.command, ['--version'], { timeout: CONDA_GENERAL_TIMEOUT })
                .then((result) => result.stdout.trim())
                .catch<string | undefined>(() => undefined);

            versionString = stdOut && stdOut.startsWith('conda ') ? stdOut.substring('conda '.length).trim() : stdOut;
        }
        if (!versionString) {
            return undefined;
        }
        const version = parse(versionString, true);
        if (version) {
            return version;
        }
        // Use a bogus version, at least to indicate the fact that a version was returned.
        // This ensures we still use conda for activation, installation etc.
        traceError(`Unable to parse version of Conda, ${versionString}`);
        return new SemVer('0.0.1');
    }
}
